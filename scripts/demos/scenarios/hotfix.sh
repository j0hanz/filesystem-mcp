# A patch that no longer fits changes nothing.

http='export function get(url) {\n  return fetch(url);\n}\n\n// retry helpers live elsewhere\n// keep this file small\n\nexport function post(url, body) {\n  return fetch(url, { method: "POST", body, keepalive: true });\n}\n'

fixture() {
  demo_file src/http.ts "$http"
  demo_file src/http.orig.ts "$http"
  demo_file hotfix.patch '--- src/http.ts\n+++ src/http.ts\n@@ -1,3 +1,3 @@\n export function get(url) {\n-  return fetch(url);\n+  return fetch(url, { cache: "no-store" });\n }\n@@ -8,3 +8,3 @@\n export function post(url, body) {\n-  return fetch(url, { method: "POST", body });\n+  return fetch(url, { method: "POST", body, cache: "no-store" });\n }\n'
}

script() {
  demo_turn "Apply hotfix.patch to src/http.ts. If it doesn't apply cleanly, leave the file alone and tell me why."
  demo_turn 'Fix the stale hunk, apply it, and diff the result against src/http.orig.ts.'
}

check() {
  assert_file_has src/http.ts 'no-store'
  assert_file_has src/http.ts 'keepalive: true'
  assert_file_lacks src/http.orig.ts 'no-store'
  assert_cast_has "$1" 'no-store'
}
