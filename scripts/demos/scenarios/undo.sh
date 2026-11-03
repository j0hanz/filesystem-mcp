# Undo skips a file you edited since, so your edit stays.

fixture() {
  demo_file src/a.ts 'export const limit = 10;\nconst t = 1;\n'
  demo_file src/b.ts 'export const limit = 10;\nconst t = 1;\n'
}

script() {
  demo_turn 'Remove the export const limit lines from everything in src.'
  demo_human "echo '// my fix' >> src/b.ts"
  demo_turn 'That was a mistake. Undo it, and leave alone anything undo skips.'
}

check() {
  assert_file_has src/a.ts 'export const limit'
  assert_file_lacks src/b.ts 'export const limit'
  assert_file_has src/b.ts '// my fix'
  assert_cast_has "$1" 'SKIPPED'
}
