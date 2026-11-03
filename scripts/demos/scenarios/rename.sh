# Rename across a repo, reviewed as one diff, with dist/ and .env untouched.

# Long diff: a higher cap keeps it on screen long enough to read.
DEMO_IDLE=2

fixture() {
  demo_file .gitignore 'dist/\n'
  demo_file .env 'API_KEY=fake-value\n# getUser\n'
  demo_file dist/bundle.js 'function getUser(){}\n'
  demo_file src/api.ts "import { getUser, getUserById } from './users';\nexport const me = () => getUser();\nexport const one = () => getUserById(1);\n"
  demo_file src/users.ts 'export function getUser() { return 1; }\nexport function getUserById(id) { return id; }\n'
  demo_file src/users.test.ts "import { getUser } from './users';\ntest('me', () => getUser());\n"
  demo_file docs/api.md 'Call `getUser` to fetch.\n'
}

script() {
  demo_turn 'Rename getUser to fetchUser across the repo, whole word only, so getUserById stays as it is.'
  demo_human "grep -c getUser dist/bundle.js .env"
}

check() {
  assert_file_has src/users.ts 'fetchUser'
  assert_file_has src/users.ts 'getUserById'
  assert_file_has src/api.ts 'getUserById'
  assert_file_has dist/bundle.js 'getUser'
  assert_file_lacks dist/bundle.js 'fetchUser'
  assert_file_has .env 'getUser'
  assert_file_lacks .env 'fetchUser'
  assert_cast_has "$1" 'fetchUser'
}
