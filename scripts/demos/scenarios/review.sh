# Review different edits to three files as one diff before anything is written.

DEMO_IDLE=1

fixture() {
  demo_file src/types.ts 'export interface Options {\n  url: string;\n}\n'
  demo_file src/client.ts 'export function call(options) {\n  return fetch(options.url);\n}\n'
  demo_file src/server.ts 'export function start(options) {\n  listen(options.url);\n}\n'
  demo_file CHANGELOG.md '- Initial release.\n'
}

script() {
  demo_turn 'Add a retries option to src/client.ts, src/server.ts and src/types.ts. Put the default in a new src/defaults.ts and add a line to CHANGELOG.md. Edit the three source files in a single batch so I can approve them at once.'
}

check() {
  assert_file_has src/client.ts 'retries'
  assert_file_has src/server.ts 'retries'
  assert_file_has src/types.ts 'retries'
  assert_file_has src/defaults.ts 'retries'
  assert_file_has CHANGELOG.md 'retries'
  assert_cast_has "$1" 'dry run'
}
