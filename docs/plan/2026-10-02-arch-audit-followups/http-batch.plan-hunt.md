# Plan hunt: [`http-batch.plan.md`](http-batch.plan.md)

## 2026-10-02

One confirmed finding. The plan goes back to write-plan before run-plan.

### Confirmed

1. **Verify commands call `grep`, which the executor's shell does not have.** Affected: steps 4, 5, 7 and 8, plus the Done list.
   - **Trigger:** the executor runs on Windows PowerShell, where `Get-Command grep` returns nothing.
   - **Impact:** each such Verify errors out. Step 7 and the Done list expect "no output" from `grep -n "MAX_WATCHERS" src/transport/http.ts`, so the error from a missing binary can pass for success.
   - **Fix:** use `git grep -n` (or `Select-String`), and state the expected output in terms of that command.

### Killed (not findings)

- **"The `createServer` `onclose` hook disposes a live stdio connection's state per exchange."** Killed. `serveStdio` pins one instance from the factory for the connection's lifetime (`@modelcontextprotocol/server/dist/stdio.mjs:270-271`). Only the opening probe is discarded, and that happens before the pinned instance replaces `activeCtx`. `disposeRuntimeState` is per-context and idempotent (`src/server.ts:195-199`).

### Checked clean

- `FilesystemServerContext` (`server.ts:30`) exists, `createServer(options, { watcherRegistry })` (`server.ts:36-40`) exists, and so does `WatcherRegistry.destroy()` (`watcher-registry.ts:334`).
- `ProtocolErrorCode` is imported in `stdio.test.ts:3`. `createRawStdioServer` (`helpers.ts:460`) and `discoverModern` (`stdio.test.ts:42`) exist.
- `__tests__/resources-subscribe.test.ts` and `docs/plan/2026-09-15-sdk-listen-hook/deletion-map.md` are tracked.

## 2026-10-02 (re-hunt after fix)

Zero findings. Finding 1 is fixed: every text-search Verify now uses `git grep -n ... -- <paths>`, and a Commands row states the exit-1 empty result. Both forms were run on the executor's shell. The plan goes to run-plan.
