# Plan 101: Tests cover the diff worker's kill path, the growth refusal after CRLF restore, and the root-only ownership checks

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report; do not improvise. When done, update the status row for this plan
> in `plans/README.md`, unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat ab54a253..HEAD -- src/core/diff.ts __tests__/diff.test.ts __tests__/rewrite.test.ts .github/workflows/ci.yml`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: tests
- **Planned at**: commit `ab54a253`, 2026-11-11

## Why this matters

Three safety nets have no test, so a regression in any of them would pass CI:

1. Large diffs run in a worker thread. If the worker never answers, a kill
   timer ends it. That timer, the worker-crash path and the
   worker-cannot-start path are never exercised.
2. `edit`, `patch` and `replace_text` refuse a change that would grow a file
   past the size limit. The check is made on the bytes that go to disk, after
   CRLF line endings are restored. The only test uses an LF file, so a
   regression to checking the pre-restore text would not be caught.
3. Two tests that check file ownership is kept on write need root and skip
   everywhere, because no CI runner is root.

## Current state

### 1. Diff worker (`src/core/diff.ts`)

```ts
// Slack past DIFF_TIMEOUT_MS before a worker that never answered is killed.
const WORKER_KILL_GRACE_MS = 500;
```

```ts
function getDiffWorker(): Worker {
  if (warmWorker !== undefined) return warmWorker;
  const worker = new Worker(WORKER_URL);
  worker.unref();
  // ...
  warmWorker = worker;
  return worker;
}
```

`patchInWorker` (`src/core/diff.ts:76-117`), module-private today:

```ts
/** Runs one structuredPatch in a worker; `undefined` on its deadline, a crash, or the kill timer. */
function patchInWorker(request: DiffWorkerRequest): Promise<StructuredPatch | undefined> {
  return new Promise((resolve) => {
    let worker: Worker | undefined;
    let settled = false;
    const onMessage = (patch: StructuredPatch | null): void => {
      finish(patch ?? undefined, false);
    };
    const onAbortOrCrash = (): void => {
      finish(undefined, true);
    };
    const finish = (patch: StructuredPatch | undefined, destroy: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(kill);
      if (worker !== undefined) {
        worker.off('message', onMessage);
        worker.off('error', onAbortOrCrash);
        worker.off('exit', onAbortOrCrash);
        worker.unref();
        if (destroy) {
          if (warmWorker === worker) warmWorker = undefined;
          void worker.terminate();
        }
      }
      resolve(patch);
    };
    const kill = setTimeout(() => {
      finish(undefined, true);
    }, request.options.timeout + WORKER_KILL_GRACE_MS);
    try {
      worker = getDiffWorker();
      worker.ref();
      worker.on('message', onMessage);
      worker.on('error', onAbortOrCrash);
      worker.on('exit', onAbortOrCrash);
      worker.postMessage(request);
    } catch {
      // A worker that cannot start degrades like one past its deadline.
      finish(undefined, true);
    }
  });
}
```

Its one caller: `runExclusive(DIFF_WORKER_KEY, () => patchInWorker(request))`.

The request type (`src/core/diff-worker.ts`):

```ts
export interface DiffWorkerRequest {
  oldName: string;
  newName: string;
  before: string;
  after: string;
  oldHeader: string;
  newHeader: string;
  options: { context?: number; timeout: number };
}
```

`__tests__/diff.test.ts` imports from `../src/core/diff.ts` like this:

```ts
import { type GeneratedPatch, twoFilesPatch, unifiedPatch } from '../src/core/diff.ts';
```

Unused exports fail the `knip` check, but test files are knip entry points,
so an export used only by a test is accepted.

### 2. Growth refusal (`src/core/rewrite.ts:140-149`)

```ts
  const after = view.restore(change.content);
  const written = !dryRun && change.write;
  // Every Rewrite tool refuses to read a file over the limit, so writing one would lock the caller out of it.
  const afterBytes = change.write ? Buffer.byteLength(after, 'utf8') : 0;
  if (afterBytes > getMaxTextFileSize()) {
    throw createTooLargeError(afterBytes, getMaxTextFileSize(), request.path, {
```

The existing test (`__tests__/rewrite.test.ts`):

```ts
it('a change that would grow the file past the size limit is refused, real or dry', async () => {
  const tooBig = 'x'.repeat(getMaxTextFileSize() + 1);
  for (const dryRun of [false, true]) {
    await assert.rejects(
      rewriteFile({ fs, path, dryRun, tool: 'edit' }, () => ({
        content: tooBig,
        result: 1,
        write: true,
      })),
      (error: unknown) => (error as { code?: unknown }).code === ErrorCode.TOO_LARGE,
    );
  }
  assert.equal(await readFile(path, 'utf8'), 'hello\n');
});
```

In that file `fs`, `path` and `root` are set in `beforeEach` (`path` is
`a.txt` holding `'hello\n'`), and `withEnv` and `MIB` are already imported.
`getMaxTextFileSize()` reads `FS_MAX_FILE_SIZE` on every call; its minimum is
1 MiB (1,048,576 bytes).

### 3. Root-only tests (`__tests__/core-fs.test.ts:770-791`)

```ts
    it('writeFile keeps the owner of a file another user owns', async (t) => {
      if (process.platform === 'win32' || process.getuid?.() !== 0) {
        return t.skip('needs root on POSIX to create a file another user owns');
      }
```

```ts
    it('keepOwner does not follow a symlink at the temp path', async (t) => {
      if (process.platform === 'win32' || process.getuid?.() !== 0) {
        return t.skip('needs root on POSIX to create a file another user owns');
      }
```

The CI test steps (`.github/workflows/ci.yml:65-74`):

```yaml
- name: Test
  # dist-smoke boots dist/index.js, so tests need a successful build.
  if: ${{ !cancelled() && steps.build.outcome == 'success' && (matrix.os != 'ubuntu-latest' || matrix.node != '') }}
  run: npm test
- name: Test with coverage floor
  # Ubuntu runs the POSIX-only sandbox branches; the floor lives in
  # package.json test:coverage. Raise it when coverage rises; never lower it
  # without a recorded reason.
  if: ${{ !cancelled() && steps.build.outcome == 'success' && matrix.os == 'ubuntu-latest' && matrix.node == '' }}
  run: npm run test:coverage
```

`ci.yml` line 1 says: "keep this workflow secret-free and contents:read". The
job names (`Check (...)`) are required by the release gate and must not
change.

## Commands you will need

| Purpose          | Command                                                      | Expected on success |
| ---------------- | ------------------------------------------------------------ | ------------------- |
| Install          | `npm ci`                                                     | exit 0              |
| Build            | `npm run build`                                              | exit 0              |
| Type-check tests | `npm run type-check:test`                                    | exit 0              |
| Lint             | `npm run lint`                                               | exit 0, no warnings |
| Diff tests       | `node --test --test-timeout=60000 __tests__/diff.test.ts`    | `# fail 0`          |
| Rewrite tests    | `node --test --test-timeout=60000 __tests__/rewrite.test.ts` | `# fail 0`          |
| Full check       | `npm run check`                                              | exit 0              |

## Scope

**In scope** (the only files you should modify):

- `src/core/diff.ts` (export `patchInWorker` and add one optional parameter; nothing else)
- `__tests__/diff.test.ts`
- `__tests__/rewrite.test.ts`
- `.github/workflows/ci.yml` (one added step)
- `plans/README.md` (status row only)

**Out of scope** (do NOT touch):

- `src/core/diff-worker.ts`, `src/core/rewrite.ts`, `__tests__/core-fs.test.ts`.
- The behavior of `patchInWorker`. If a new test fails against the current
  code, that is a finding to report, not something to fix here.
- `package.json` scripts and the coverage floor.
- Any CI job or step name.

## Git workflow

- Branch: `advisor/101-tests-for-diff-worker-kill-and-crlf-growth`
- Three commits. Message style from `git log`:
  `refactor(diff): return counts from generation`. Use
  `test(diff): cover the worker's kill, crash and start-failure paths`,
  `test(rewrite): cover the growth refusal after CRLF restore`,
  `ci: run the root-only ownership tests on Ubuntu`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Let a test supply the worker

In `src/core/diff.ts`, change the signature and the one line that gets the
worker. Nothing else in the function changes.

```ts
/**
 * Runs one structuredPatch in a worker; `undefined` on its deadline, a crash, or the kill timer.
 * `spawn` exists for tests, which pass a worker that never answers.
 */
export function patchInWorker(
  request: DiffWorkerRequest,
  spawn: () => Worker = getDiffWorker,
): Promise<StructuredPatch | undefined> {
```

and inside the `try`: `worker = spawn();`

**Verify**: `npm run build` → exit 0.

### Step 2: Diff worker tests

In `__tests__/diff.test.ts`, add `patchInWorker` to the import from
`../src/core/diff.ts`, add `import { EventEmitter } from 'node:events';` and
`import type { Worker } from 'node:worker_threads';`, and add inside
`describe('core/diff', ...)`:

```ts
const request = (timeout: number) => ({
  oldName: 'f',
  newName: 'f',
  before: 'a\n',
  after: 'b\n',
  oldHeader: '',
  newHeader: '',
  options: { timeout },
});

/** A worker that takes the request and never answers. */
class SilentWorker extends EventEmitter {
  terminated = false;
  postMessage(): void {}
  ref(): void {}
  unref(): void {}
  terminate(): Promise<number> {
    this.terminated = true;
    return Promise.resolve(0);
  }
}
const asWorker = (worker: SilentWorker): Worker => worker as unknown as Worker;

it('a worker that never answers is killed after the deadline plus grace', async () => {
  const worker = new SilentWorker();
  const started = performance.now();
  const patch = await patchInWorker(request(50), () => asWorker(worker));
  assert.strictEqual(patch, undefined);
  assert.strictEqual(worker.terminated, true);
  assert.ok(performance.now() - started >= 500, 'waits for the deadline and the grace');
});

it('a worker that exits mid-diff yields no patch and is terminated', async () => {
  const worker = new SilentWorker();
  const pending = patchInWorker(request(5000), () => asWorker(worker));
  worker.emit('exit', 1);
  assert.strictEqual(await pending, undefined);
  assert.strictEqual(worker.terminated, true);
});

it('a worker that cannot start yields no patch', async () => {
  const patch = await patchInWorker(request(5000), () => {
    throw new Error('no worker');
  });
  assert.strictEqual(patch, undefined);
});
```

**Verify**: `node --test --test-timeout=60000 __tests__/diff.test.ts` →
`# fail 0`, three new tests pass. `npm run lint` → exit 0 (if lint rejects
the empty methods, give each a one-line comment body such as
`/* the fake takes no action */`).

### Step 3: Growth refusal after CRLF restore

In `__tests__/rewrite.test.ts`, directly after the test
`'a change that would grow the file past the size limit is refused, real or dry'`,
add:

```ts
it('the growth refusal counts the bytes after CRLF endings are restored', async () => {
  await writeFile(path, 'a\r\n');
  // 800,000 bytes as the LF view, 1,200,000 once every LF is CRLF again: over a 1 MiB limit.
  const viewText = 'a\n'.repeat(400_000);
  await withEnv({ FS_MAX_FILE_SIZE: String(MIB) }, async () => {
    for (const dryRun of [false, true]) {
      await assert.rejects(
        rewriteFile({ fs, path, dryRun, tool: 'edit' }, () => ({
          content: viewText,
          result: 1,
          write: true,
        })),
        (error: unknown) => (error as { code?: unknown }).code === ErrorCode.TOO_LARGE,
      );
    }
  });
  assert.equal(await readFile(path, 'utf8'), 'a\r\n');
});
```

**Verify**: `node --test --test-timeout=60000 __tests__/rewrite.test.ts` →
`# fail 0`.

Then prove the test bites: temporarily change `src/core/rewrite.ts` line
`const afterBytes = change.write ? Buffer.byteLength(after, 'utf8') : 0;` to
use `change.content` in place of `after`, run the same command, and confirm
the new test FAILS. **Revert that change** (`git checkout -- src/core/rewrite.ts`)
and confirm `git diff --stat -- src/core/rewrite.ts` prints nothing.

### Step 4: Run the root-only tests in CI

In `.github/workflows/ci.yml`, add this step directly after the
`Test with coverage floor` step, at the same indentation:

```yaml
- name: Root-only ownership tests
  # Two core-fs tests need uid 0 and skip everywhere else; run just those as root.
  if: ${{ !cancelled() && steps.build.outcome == 'success' && matrix.os == 'ubuntu-latest' && matrix.node == '' }}
  run: sudo env "PATH=$PATH" node --test --test-timeout=60000 --test-name-pattern="keeps the owner of a file another user owns|keepOwner does not follow a symlink" __tests__/core-fs.test.ts
```

**Verify**: `npx prettier --check .github/workflows/ci.yml` → exit 0. On
Linux with sudo available, run the `run:` command locally and confirm
`# pass 2` and `# fail 0`. Otherwise this step is verified only when CI runs;
say so in your report.

### Step 5: Full check

**Verify**: `npm run check` → exit 0.

## Test plan

- `__tests__/diff.test.ts`: three new tests (kill timer, exit, start failure).
- `__tests__/rewrite.test.ts`: one new test (CRLF growth), proven to fail
  against a deliberately broken check in Step 3.
- CI: one new step running two existing tests as root.

## Done criteria

- [ ] `npm run check` exits 0
- [ ] `grep -c "patchInWorker" __tests__/diff.test.ts` returns at least 4
- [ ] `grep -n "after CRLF endings are restored" __tests__/rewrite.test.ts` returns 1 match
- [ ] `grep -n "Root-only ownership tests" .github/workflows/ci.yml` returns 1 match
- [ ] `git diff --stat ab54a253..HEAD -- src/core/rewrite.ts` prints nothing
- [ ] `git status --short` lists only the in-scope files
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `patchInWorker` does not match the excerpt.
- A new diff test fails against the unchanged logic (for example the fake is
  not terminated). That is a real finding: report it, do not change
  `patchInWorker`'s behavior.
- The Step 3 test passes even with the deliberately broken check.
- `knip` reports `patchInWorker` as an unused export.
- The root-only step fails in CI because the tests' setup (temp directories
  made by a `before` hook) breaks under root. Report the output; do not widen
  the name pattern or edit `core-fs.test.ts`.

## Maintenance notes

- The kill-timer test takes about 0.55 s by design (50 ms deadline plus the
  500 ms grace).
- `spawn` is a test seam, not a feature: production always uses the default.
- If the CI step proves flaky, the fallback is to drop it; the two tests then
  go back to never running, which is today's state.
