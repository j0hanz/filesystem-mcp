# Plan 035: A file subscription keeps notifying after the server's own atomic replace (Linux/macOS)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 8c2a82cd..HEAD -- src/core/watcher-registry.ts src/core/fs.ts __tests__/resources-subscribe.test.ts`
> If `watcher-registry.ts:191-221` changed, compare against the excerpt
> before proceeding; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED (touches the watcher lifecycle; Windows behavior unchanged)
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `8c2a82cd`, 2026-09-26

## Why this matters

A file subscription calls `fs.watch(<file>)`. On Linux (inotify) and macOS
(kqueue) that watch is bound to the file's **inode**. Every server-side write
— `edit`, `patch`, `create` overwrite, `replace_text` — commits by renaming a
temp file over the target (`src/core/fs.ts:110`), which puts a **new** inode
at the path. Node's documentation ("Inodes" under `fs.watch`) spells out the
consequence: the watcher keeps watching the old inode. The subscriber gets
one notification for the replace and then nothing — not for the server's
next write, not for a rename-saving editor.

Windows is unaffected: libuv watches the parent directory there and filters
by name. That is also why CI never catches this: the only subscription test
mutates the file with `writeFile` (same inode), and the Ubuntu job never
runs an `edit` against a subscribed file.

The fix does for every platform what libuv already does on Windows: for a
file URI, watch the **parent directory** (non-recursive) and fire only for
events whose `filename` is the subscribed file's basename. Directory URIs
keep their recursive watch.

Not reproduced on this Windows host; the mechanism is documented Node
behavior and the code path is unambiguous. The regression test below fails
on Linux/macOS before the fix and passes everywhere after.

## Current state

```ts
// src/core/watcher-registry.ts:1-2 (imports)
import type { FSWatcher } from 'node:fs';
import { statSync, watch } from 'node:fs';
```

```ts
// src/core/watcher-registry.ts:191-221
const attach = (uri: string, resolvedPath: string): boolean => {
  try {
    // Watch directories recursively (children included) and files as-is.
    // `fs.watch` async errors arrive via the 'error' event below, not as a
    // sync throw, so no recursive-fallback try/catch is needed here — the
    // outer catch handles sync throws (inotify exhaustion, path-race).
    // `{ recursive: true }` is honored on macOS, Windows, and — since Node
    // 20.13 — Linux; `engines.node` is >=24, so all three are covered.
    const recursive = statSync(resolvedPath).isDirectory();
    const watcher = watch(resolvedPath, recursive ? { recursive: true } : undefined, () => {
      notifyAll(uri);
    });
    watcher.on('error', (err: Error) => {
      Logger.warn(`Watcher error for ${uri}: ${err.message}`);
      dropWatcher(uri, watcher);
    });
    // Two attaches that both cleared `hasWatcher` before either finished
    // validating land here for the same uri. Keep the one already wired to
    // the callback set and close this one — overwriting the map entry would
    // strand the first watcher's fd with nothing left holding a reference.
    if (watchers.has(uri)) {
      watcher.close();
      return true;
    }
    watchers.set(uri, watcher);
    return true;
  } catch (err) {
    Logger.error(`Failed to create watcher for ${uri}: ${formatUnknownErrorMessage(err)}`);
    return false;
  }
};
```

`notifyAll(uri)` (lines 105–129) debounces 50 ms per URI and fans out to
every registered callback. `MAX_WATCHERS` (line 12) counts `watchers.size`,
one entry per URI — unchanged by this plan (two files in one directory still
cost two entries).

```ts
// src/core/fs.ts:104-110 (the commit of every atomic write)
// Last cancellation point. The rename IS the commit: once it starts the
// target may already be replaced, so it is never raced against the
// signal — a withAbort race would report a finished write as failed, and
// a client retry would apply it twice (same reasoning as appendFile).
signal?.throwIfAborted();
await fsRename(tempPath, validPath);
```

Test conventions (`__tests__/resources-subscribe.test.ts`): one `pair` from
`createTestClientPair([tmpDir])` (2025-era in-memory client with tools and
`resources/subscribe`); `buildFileResourceUri(path)`;
`pair.client.setNotificationHandler('notifications/resources/updated', …)`
with a counter and `waitFor(() => count > n, 2000)` (line 59–85 shows the
pattern). The client can also call tools: `pair.client.callTool({ name: 'edit', arguments: { path, edits: [{ oldText, newText }] } })`
performs an atomic write through the server.

## Commands you will need

| Purpose       | Command                                                                                                                                        | Expected on success |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| Static check  | `npm run check:static`                                                                                                                         | exit 0              |
| All tests     | `npm test`                                                                                                                                     | all pass            |
| Subscriptions | `node --test __tests__/resources-subscribe.test.ts __tests__/subscriptions-listen.test.ts __tests__/stdio.test.ts __tests__/resources.test.ts` | all pass            |
| Format        | `npx prettier --write src/core/watcher-registry.ts __tests__/resources-subscribe.test.ts`                                                      | exit 0              |

## Scope

**In scope** (the only files you should modify):

- `src/core/watcher-registry.ts` — `attach` and its imports
- `__tests__/resources-subscribe.test.ts` — one new test
- `plans/README.md` (status row)

**Out of scope**: the debounce; `MAX_WATCHERS` accounting; directory
subscriptions (recursive watch stays); the Linux recursive-watch cost
(separate audit finding, not selected); `fs.ts`.

## Git workflow

- Branch: `advisor/035-watch-parent-dir-for-file-subscriptions`.
- One commit: `fix(watcher): watch a file's parent directory so atomic replaces keep notifying`.
- End each commit message with the attribution line the operator's
  environment requires, if any.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Regression test (fails on Linux/macOS now; passes on Windows)

In `__tests__/resources-subscribe.test.ts`, add inside the `describe`:

```ts
it("a subscription survives the server's own atomic replace and keeps notifying", async () => {
  const filePath = await writeTestFile(tmpDir, 'replaced.txt', 'one\n');
  const uri = buildFileResourceUri(filePath);
  let count = 0;
  pair.client.setNotificationHandler('notifications/resources/updated', (n) => {
    if ((n.params as { uri: string }).uri === uri) count += 1;
  });
  await pair.client.subscribeResource({ uri });

  // Each edit commits by renaming a temp file over the path: a new inode.
  const edit = (oldText: string, newText: string) =>
    pair.client.callTool({
      name: 'edit',
      arguments: { path: filePath, edits: [{ oldText, newText }] },
    });

  const first = await edit('one', 'two');
  assert.notStrictEqual(first.isError, true);
  await waitFor(() => count >= 1, 3000);
  assert.ok(count >= 1, 'the first replace must notify');

  const seen = count;
  const second = await edit('two', 'three');
  assert.notStrictEqual(second.isError, true);
  await waitFor(() => count > seen, 3000);
  assert.ok(count > seen, 'the second replace must notify too (inode-bound watch went silent)');

  await pair.client.unsubscribeResource({ uri });
});
```

**Verify**: `node --test __tests__/resources-subscribe.test.ts` → on Linux or
macOS the new test **fails** at "the second replace must notify too"; on
Windows it passes already. If you are on Windows, record that the pre-fix
failure is expected on the Ubuntu CI job (`ci.yml` runs both) and continue.

### Step 2: Watch the parent for files

In `src/core/watcher-registry.ts`:

1. Add `import { basename, dirname } from 'node:path';` to the imports.
2. Replace lines 193–202 (the comment block, `recursive`, and the `watch(...)`
   call) with:

   ```ts
   // Directories: one recursive watch (children included). `{ recursive:
   // true }` is honored on macOS, Windows, and — since Node 20.13 — Linux;
   // `engines.node` is >=24, so all three are covered.
   //
   // Files: watch the PARENT directory and filter by name. A watch on the
   // file itself binds to its inode on Linux/macOS, and every atomic write
   // here renames a new inode over the path (fs.ts), after which the old
   // watch never fires again (Node docs, fs.watch "Inodes"). Windows'
   // libuv already watches the parent; this makes the other two match.
   // `filename` can be null on some platforms/events; then notify anyway —
   // a spurious debounced notification beats a missed one.
   //
   // `fs.watch` async errors arrive via the 'error' event below, not as a
   // sync throw; the outer catch handles sync throws (inotify exhaustion,
   // path-race).
   const isDirectory = statSync(resolvedPath).isDirectory();
   const watcher = isDirectory
     ? watch(resolvedPath, { recursive: true }, () => {
         notifyAll(uri);
       })
     : watch(dirname(resolvedPath), (_event, filename) => {
         if (filename === null || filename === basename(resolvedPath)) notifyAll(uri);
       });
   ```

   Keep everything from `watcher.on('error', …)` onward unchanged.

Run `npx prettier --write src/core/watcher-registry.ts __tests__/resources-subscribe.test.ts`.

**Verify**: `node --test __tests__/resources-subscribe.test.ts __tests__/subscriptions-listen.test.ts __tests__/stdio.test.ts __tests__/resources.test.ts`
→ all pass. The `filename` parameter is typed `string | null` by
`@types/node` for a string-encoding watch; if the compiler reports
`Buffer` in the union, add `typeof filename !== 'string' ||` in place of
`filename === null ||`.

### Step 3: Full gate

**Verify**: `npm run check` → exit 0. Then run
`node --test __tests__/resources-subscribe.test.ts` three more times: the
existing "exactly one notification" assertions (lines 76–84) must stay green
— a parent-directory watch on Windows can report more than one raw event per
write, but they all fall inside the 50 ms debounce as before.

## Test plan

- New test: subscribe → `edit` → notification → `edit` again → notification
  again. Fails before the fix on Linux/macOS; passes everywhere after.
- Existing: the three tests in `resources-subscribe.test.ts` (including the
  "doubled subscribe fires once" one), `subscriptions-listen.test.ts`
  (modern era, HTTP and stdio), `STDIO-003…014`, `resources.test.ts` 063–067.

## Done criteria

ALL must hold:

- [ ] `npm run check` exits 0 on the executor's platform
- [ ] The new test exists and passes; on Linux/macOS it was observed failing
      before Step 2 (or the Ubuntu CI run of the pre-fix commit shows it)
- [ ] `grep -n "watch(dirname(resolvedPath)" src/core/watcher-registry.ts` prints one line
- [ ] `git status` shows changes only in the in-scope files
- [ ] `plans/README.md` status row for 035 updated

## STOP conditions

Stop and report back (do not improvise) if:

- On Linux/macOS the regression test passes before Step 2 (then the inode
  behavior differs from the documentation on that Node version — report
  `node --version`).
- After Step 2 any existing subscription test fails more than once in five
  runs (a new flake from extra parent-directory events).
- `subscriptions-listen.test.ts` reports notifications for files that were
  **not** subscribed (the basename filter is wrong) — report the filenames
  seen.
- A step's verification fails twice after a reasonable fix attempt.

## Maintenance notes

- Two file subscriptions in one directory now hold two watches on the same
  directory. That is what Windows already did; if it ever matters, key
  parent watches by directory and multiplex — a bigger change than this one.
- The subscribed file being **deleted** now produces a `rename` event from
  the parent watch and one notification, after which the watch stays alive
  (the directory still exists). Previously the file watch errored and was
  dropped. Subscribers already tolerate a notification for a missing file
  (`resources/read` then answers not-found).
- Reviewer focus: `basename(resolvedPath)` is compared to the event's
  `filename` verbatim. `resolvedPath` is a realpath, so its case matches the
  on-disk spelling the OS reports.
