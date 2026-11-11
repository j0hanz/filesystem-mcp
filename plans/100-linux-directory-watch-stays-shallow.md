# Plan 100: On Linux a directory subscription watches the directory, not its whole tree

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report; do not improvise. When done, update the status row for this plan
> in `plans/README.md`, unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat ab54a253..HEAD -- src/core/watcher-registry.ts __tests__/resources.test.ts __tests__/subscriptions-listen.test.ts CHANGELOG.md`
> Plan 092 is expected to have changed the attach-failure rollback in
> `src/core/watcher-registry.ts`. Any other difference from the "Current
> state" excerpts is a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: MED (changes what a directory subscriber is told on Linux)
- **Depends on**: `plans/092-watcher-leases-stay-balanced.md` (same file; land it first)
- **Category**: security
- **Planned at**: commit `ab54a253`, 2026-11-11

## Why this matters

A client can subscribe to a directory URI. The server then calls
`fs.watch(dir, { recursive: true })`. On macOS and Windows that is one kernel
watch. On Linux, Node implements `recursive` in JavaScript: it walks the whole
tree synchronously and arms one inotify watch per directory. One subscription
to a large allowed root (a monorepo with `node_modules`) therefore blocks the
server's event loop for the length of the walk and can use up the user's
inotify watches, which also breaks watchers in the user's editor and build
tools. The server promises in `SECURITY.md` that "no input can crash or hang
the server", and its watcher cap (`FS_MAX_WATCHERS`, 256) counts
subscriptions, not inotify watches, so the cap does not bound this.

The basis is a reading of Node's Linux recursive watcher
(`lib/internal/fs/recursive_watch.js`, Node 26). It was **not measured**, and
the Node 24 implementation was not read.

The fix is to watch a directory non-recursively on Linux: changes to its
direct children are still reported, changes deeper in the tree are not. No
document promises deep notifications, and the existing test already avoids
asserting them on Linux.

## Current state

Files:

- `src/core/watcher-registry.ts`: `createWatcherRegistry()`; `attach`
  creates the OS watcher.
- `__tests__/resources.test.ts`: unit tests on the registry (search
  `TC-FUNC-063`).
- `__tests__/subscriptions-listen.test.ts`: the directory-watch test over
  HTTP.

The cap comment (`src/core/watcher-registry.ts:12-14`):

```ts
// Cap concurrent file watchers to avoid exhausting OS-level watch handles
// (e.g. Linux inotify, default ~8192/user). One subscription == one watcher.
export const MAX_WATCHERS = parseEnvInt('FS_MAX_WATCHERS', 256, 1, 4096);
```

`attach` (`src/core/watcher-registry.ts:193-217`):

```ts
  const attach = (uri: string, resolvedPath: string): boolean => {
    try {
      // Directories: one recursive watch (children included). `{ recursive:
      // true }` is honored on macOS, Windows, and — since Node 20.13 —
      // Linux; `engines.node` is >=24, so all three are covered.
      //
      // Files: watch the PARENT directory and filter by name. A watch on
      // ...
      const isDirectory = statSync(resolvedPath).isDirectory();
      const watcher = isDirectory
        ? watch(resolvedPath, { recursive: true }, () => {
            notifyAll(uri);
          })
        : watch(dirname(resolvedPath), (_event, filename) => {
            if (filename === null || isSamePath(filename, basename(resolvedPath))) notifyAll(uri);
          });
```

The existing directory test's own comment
(`__tests__/subscriptions-listen.test.ts:315-322`):

```ts
// Recursive directory watch (#13): one client subscribes to a DIRECTORY URI.
// Pre-fix, `attach` called `watch(path, cb)` with no options, so child changes
// were not reported. With `{ recursive: true }` for directories, creating a
// child file must notify the subscriber. Note: this creates a DIRECT child,
// which a non-recursive directory watch also catches; nested-grandchild
// coverage depends on platform recursive support (macOS/Windows only — see the
// `attach` ponytail comment), so it is not asserted here to stay green on Linux.
describe('HTTP recursive directory watch', () => {
```

That test creates a direct child and must keep passing on every platform.

Registry test exemplar (`__tests__/resources.test.ts`, `TC-FUNC-063`):

```ts
const registry = createWatcherRegistry();
const testFile = await writeTestFile(tmpDir, 'watch_test.txt', 'initial');
const testUri = buildFileResourceUri(testFile);

const notifications: string[] = [];
const result = await registry.acquire(pathGuard, testUri, (uri) => {
  notifications.push(uri);
});
assert.strictEqual(result.ok, true);
// ...
await waitFor(() => notifications.length > 0, 1000);
// ...
registry.destroy();
```

A platform-gated test in the same file uses
`it('name', { skip: !IS_CASE_INSENSITIVE_FS }, async () => { ... })`.

Notifications are debounced by 50 ms per URI.

## Commands you will need

| Purpose          | Command                                                                   | Expected on success |
| ---------------- | ------------------------------------------------------------------------- | ------------------- |
| Install          | `npm ci`                                                                  | exit 0              |
| Type-check tests | `npm run type-check:test`                                                 | exit 0              |
| Lint             | `npm run lint`                                                            | exit 0, no warnings |
| Registry tests   | `node --test --test-timeout=60000 __tests__/resources.test.ts`            | `# fail 0`          |
| Listen tests     | `node --test --test-timeout=60000 __tests__/subscriptions-listen.test.ts` | `# fail 0`          |
| Full check       | `npm run check`                                                           | exit 0              |

## Scope

**In scope** (the only files you should modify):

- `src/core/watcher-registry.ts`
- `__tests__/resources.test.ts`
- `__tests__/subscriptions-listen.test.ts` (the comment above the directory test only)
- `CHANGELOG.md`
- `plans/README.md` (status row only)

**Out of scope** (do NOT touch):

- The file branch of `attach` (watching the parent directory and filtering by
  name).
- `MAX_WATCHERS` and its accounting.
- `src/resources.ts`, `src/transport/*`.
- A recursive watcher of the server's own (walking with exclusions): a larger
  design the maintainer has not asked for.

## Git workflow

- Branch: `advisor/100-linux-directory-watch-stays-shallow`
- One commit: `fix(watcher): watch a directory without recursion on Linux`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add the Linux test

In `__tests__/resources.test.ts`, next to `TC-FUNC-063`, add a test that is
skipped unless `process.platform === 'linux'`:

```ts
it(
  'WatcherRegistry - on Linux a directory watch reports direct children only',
  { skip: process.platform !== 'linux' },
  async () => {
    const registry = createWatcherRegistry();
    try {
      const dir = join(tmpDir, 'shallow-watch');
      await mkdir(join(dir, 'sub'), { recursive: true });
      const notifications: string[] = [];
      const result = await registry.acquire(pathGuard, buildFileResourceUri(dir), (uri) => {
        notifications.push(uri);
      });
      assert.strictEqual(result.ok, true);

      // A change two levels down is not reported.
      await writeFile(join(dir, 'sub', 'deep.txt'), 'deep');
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.strictEqual(notifications.length, 0, 'no notification for a nested change');

      // A direct child is.
      await writeFile(join(dir, 'child.txt'), 'child');
      await waitFor(() => notifications.length > 0, 1000);
    } finally {
      registry.destroy();
    }
  },
);
```

Use the imports the file already has (`join`, `mkdir`, `writeFile`,
`waitFor`); add any that are missing to the existing import lines.

**Verify**: `node --test --test-timeout=60000 __tests__/resources.test.ts` →
on Linux the new test FAILS at "no notification for a nested change"; on
Windows and macOS it is skipped and the file reports `# fail 0`.

### Step 2: Do not recurse on Linux

In `src/core/watcher-registry.ts`:

1. Replace the first comment paragraph inside `attach` (the three lines that
   begin `// Directories: one recursive watch`) with:

```ts
// Directories: one recursive watch on macOS and Windows, where the
// kernel provides it. Not on Linux: Node's recursive watch there walks
// the whole tree synchronously and arms one inotify watch per directory,
// so one subscription to a large root would block the event loop and
// could use up the user's inotify watches. A Linux directory watch
// reports its direct children only.
```

2. Change the directory branch to:

```ts
        ? watch(resolvedPath, { recursive: process.platform !== 'linux' }, () => {
            notifyAll(uri);
          })
```

**Verify**: `grep -n "recursive: process.platform !== 'linux'" src/core/watcher-registry.ts`
→ 1 match. `node --test --test-timeout=60000 __tests__/resources.test.ts` →
`# fail 0`.

### Step 3: Correct the test comment

In `__tests__/subscriptions-listen.test.ts`, replace the comment block above
`describe('HTTP recursive directory watch', ...)` with:

```ts
// Directory watch (#13): one client subscribes to a DIRECTORY URI and creating
// a child file must notify it. The child is a DIRECT child on purpose: macOS
// and Windows watch the tree, Linux watches the directory alone (see `attach`),
// so only a direct child is reported everywhere.
```

Do not change the test body or the `describe` name.

**Verify**: `node --test --test-timeout=60000 __tests__/subscriptions-listen.test.ts`
→ `# fail 0`.

### Step 4: Changelog and full check

In `CHANGELOG.md`, under `## [Unreleased]` → `### Changed`, append:

```markdown
- **Resource subscriptions**: on Linux, a subscription to a directory now reports changes to its direct children only; before, it walked and watched the whole tree, which could block the server and use up the user's inotify watches on a large folder. macOS and Windows still report the whole tree.
```

**Verify**: `npm run check` → exit 0.

## Test plan

- One new Linux-only test in `__tests__/resources.test.ts` (Step 1). It runs
  in CI on the two Ubuntu legs.
- The existing `'subscriber is notified when a child file is created under the directory'`
  test covers the direct-child case on all platforms.

## Done criteria

- [ ] `npm run check` exits 0
- [ ] `grep -c "recursive: true" src/core/watcher-registry.ts` returns 0
- [ ] `grep -n "reports direct children only" __tests__/resources.test.ts` returns 1 match
- [ ] `git status --short` lists only the in-scope files
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- Plan 092 has not landed.
- `grep -rn -i "recursive" README.md docs/client-guide.md docs/configuration.md`
  finds a sentence promising that a directory subscription reports nested
  changes. That is a documented contract; the maintainer must decide.
- You are on Linux and the new test passes before Step 2 (Node's recursive
  watch did not report the nested change, so the premise needs re-checking).
- You are not on Linux: finish the steps, but report that the Linux test is
  unverified locally and leave the row `IN PROGRESS: needs a Linux run`.
- The existing HTTP directory test fails on any platform after Step 2.

## Maintenance notes

- This is a behavior change for Linux clients that relied on deep
  notifications. The maintainer should confirm before merging; the audit
  found no documentation of deep notifications.
- If deep notifications are wanted on Linux later, the safe design is a walk
  of the server's own that skips ignored and sensitive directories and stops
  at an entry budget.
- The `MAX_WATCHERS` comment "One subscription == one watcher" becomes true
  on Linux again with this change.
