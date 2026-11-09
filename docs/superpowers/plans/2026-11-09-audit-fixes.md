# Audit fixes implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the 7 audit findings of 2026-11-09: HTTP shutdown keep-alive hangs, Windows reserved console device names (`CONIN$`, `CONOUT$`, `COM0`, `LPT0`), non-C drive Windows system folder protection, batch create directory-file collision validation, `runExclusive` rejection payload leaks, and sorting hot-path re-computations in `find_files` and `list`.

**Architecture:** Seven self-contained, independent tasks across transport, path security, schema validation, concurrency, and tool sorting logic. Each task has its own isolated unit test, minimal code change, changelog update (where user-facing), and git commit.

**Tech Stack:** TypeScript, Node.js 24+ built-in test runner (`node:test`, `node:assert/strict`), Express 5, MCP SDK.

**Spec:** The ponytail audit report of 2026-11-09. Each task quotes its finding and reproduces the exact failure condition.

## Global Constraints

- Work on a branch, not `main`. Never hand-edit a version in `package.json`, `server.json`, `mcpb/manifest.json`, `.codex-plugin/plugin.json`, or `.cursor-plugin/plugin.json`.
- Each user-visible fix adds one bullet under `## [Unreleased]` / `### Fixed` in `CHANGELOG.md`, in the existing style: bold sentence, then what changed.
- If a contract change is intended, run `node --test --test-update-snapshots __tests__/contract.test.ts` with no `FS_*` variables set and commit the `.snapshot` diff. No task here intends one.
- After modifying code, run `graphify update .`.
- Do not lower the coverage floor in `npm run test:coverage`.

## Review Focus

Each line has its test in the owning task.

1. An HTTP client with an open keep-alive connection does not delay server shutdown beyond a few milliseconds. Task 1.
2. A path using a Windows console alias with extensions or mixed case (`conin$.txt`, `ConOut$`) is recognized as a reserved device name and blocked. Task 2.
3. Windows system paths on non-C drives (`D:\Windows`, custom `%SystemRoot%`) are identified and rejected by `isUnsafeCwdPath`. Task 3.
4. A batch create request containing conflicting directory and file paths (including case-folded or Unicode equivalent paths) is rejected by schema refinement before filesystem operations begin. Task 4.
5. A function queued in `runExclusive` that accepts optional arguments is never passed the preceding operation's rejection error. Task 5.

---

### Task 1: Close idle keep-alive connections on HTTP server shutdown

**Finding 1:** `httpServer.close` stops accepting new connections but waits up to 65 seconds (`KEEPALIVE_TIMEOUT_MS = 65_000`) for idle keep-alive connections to close naturally. The process teardown coordinator in `src/index.ts` enforces a 5-second `SHUTDOWN_TIMEOUT_MS`, causing any shutdown with connected clients to time out and exit with error code 1.

**Files:**

- Modify: `src/transport/http.ts:367-373`
- Modify: `CHANGELOG.md`
- Test: `__tests__/http-server.test.ts`

**Interfaces:**

- Consumes: `httpServer.closeIdleConnections()` (Node.js HTTP Server API)
- Produces: immediate teardown of idle HTTP connections during `httpServer.close()`

- [ ] **Step 1: Write the failing test**

In `__tests__/http-server.test.ts`, add a test in the HTTP server integration suite:

```ts
it('closes immediately on shutdown even with an idle keep-alive client connected', async () => {
  const agent = new Agent({ keepAlive: true });
  try {
    const res = await new Promise<{ statusCode?: number }>((resolve, reject) => {
      const req = request(new URL('/health', base), { method: 'GET', agent }, (r) => {
        r.resume();
        r.on('end', () => resolve({ statusCode: r.statusCode }));
      });
      req.on('error', reject);
      req.end();
    });
    assert.strictEqual(res.statusCode, 200);

    // With keep-alive, connection remains idle. Server close must resolve quickly.
    const start = Date.now();
    await new Promise<void>((resolve, reject) => {
      http.server.close((err) => (err ? reject(err) : resolve()));
    });
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 2000, `Expected server to close in <2s, took ${elapsed}ms`);
  } finally {
    agent.destroy();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-name-pattern="closes immediately on shutdown even with an idle keep-alive client" __tests__/http-server.test.ts`
Expected: FAIL (times out or takes longer than 2000ms because idle keep-alive socket keeps server open).

- [ ] **Step 3: Implement `closeIdleConnections()` in `src/transport/http.ts`**

In `src/transport/http.ts:368-373`, call `httpServer.closeIdleConnections()` before triggering `originalClose`:

```ts
const originalClose = httpServer.close.bind(httpServer);
httpServer.close = function (callback?: (error?: Error) => void) {
  httpServer.closeIdleConnections();
  void teardown().then(() => {
    originalClose(callback);
  });
  return httpServer;
};
```

- [ ] **Step 4: Update `CHANGELOG.md`**

Under `## [Unreleased]` / `### Fixed`:
`- **HTTP graceful shutdown**: close idle keep-alive connections immediately so server disposal finishes within the process shutdown budget.`

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test --test-name-pattern="closes immediately on shutdown even with an idle keep-alive client" __tests__/http-server.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/transport/http.ts __tests__/http-server.test.ts CHANGELOG.md
git commit -m "fix(http): close idle connections immediately on server shutdown"
```

---

### Task 2: Block Windows console and device handles (`CONIN$`, `CONOUT$`, `COM0`, `LPT0`)

**Finding 2:** `RESERVED_DEVICE_NAMES` blocks standard DOS device names (`CON`, `PRN`, `AUX`, `COM1`-`COM9`), but omits `CONIN$`, `CONOUT$`, `COM0`, and `LPT0`. On Windows, reading `CONIN$` attempts to read standard console input, blocking Node indefinitely.

**Files:**

- Modify: `src/core/path-utils.ts:73-96`
- Modify: `CHANGELOG.md`
- Test: `__tests__/path-helpers.test.ts`

**Interfaces:**

- Consumes: `RESERVED_DEVICE_NAMES`, `getReservedDeviceNameForPath`
- Produces: Reserved device identification for `CONIN$`, `CONOUT$`, `COM0`, `LPT0`

- [ ] **Step 1: Write the failing test**

In `__tests__/path-helpers.test.ts`, add a test suite for reserved device detection:

```ts
import { getReservedDeviceNameForPath } from '../src/core/path-utils.ts';

describe('Windows reserved device names', () => {
  it('identifies CONIN$, CONOUT$, COM0, and LPT0 as reserved device names', () => {
    assert.strictEqual(getReservedDeviceNameForPath('C:/workspace/CONIN$'), 'CONIN$');
    assert.strictEqual(getReservedDeviceNameForPath('C:/workspace/conin$.txt'), 'conin$');
    assert.strictEqual(getReservedDeviceNameForPath('CONOUT$'), 'CONOUT$');
    assert.strictEqual(getReservedDeviceNameForPath('COM0'), 'COM0');
    assert.strictEqual(getReservedDeviceNameForPath('LPT0'), 'LPT0');
    assert.strictEqual(getReservedDeviceNameForPath('C:/workspace/valid_file.txt'), undefined);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-name-pattern="identifies CONIN" __tests__/path-helpers.test.ts`
Expected: FAIL (`AssertionError: undefined == 'CONIN$'`)

- [ ] **Step 3: Update `RESERVED_DEVICE_NAMES` in `src/core/path-utils.ts`**

Add `'CONIN$'`, `'CONOUT$'`, `'COM0'`, and `'LPT0'` to `RESERVED_DEVICE_NAMES`:

```ts
const RESERVED_DEVICE_NAMES = new Set<string>([
  'CON',
  'CONIN$',
  'CONOUT$',
  'PRN',
  'AUX',
  'NUL',
  'COM0',
  'COM1',
  'COM2',
  'COM3',
  'COM4',
  'COM5',
  'COM6',
  'COM7',
  'COM8',
  'COM9',
  'LPT0',
  'LPT1',
  'LPT2',
  'LPT3',
  'LPT4',
  'LPT5',
  'LPT6',
  'LPT7',
  'LPT8',
  'LPT9',
]);
```

- [ ] **Step 4: Update `CHANGELOG.md`**

Under `## [Unreleased]` / `### Fixed`:
`- **Windows device paths**: block CONIN$, CONOUT$, COM0, and LPT0 device names to prevent console input hangs.`

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test --test-name-pattern="identifies CONIN" __tests__/path-helpers.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/core/path-utils.ts __tests__/path-helpers.test.ts CHANGELOG.md
git commit -m "fix(core): block Windows CONIN$, CONOUT$, COM0, and LPT0 device names"
```

---

### Task 3: Derive Windows unsafe system directories dynamically

**Finding 3:** `UNSAFE_SYSTEM_DIRS` in `src/core/path-discovery.ts` hardcodes drive `C:`, leaving Windows installations on other drives (e.g. `D:\Windows`) or custom system directories unflagged by `isUnsafeCwdPath`.

**Files:**

- Modify: `src/core/path-discovery.ts:61-65`
- Modify: `CHANGELOG.md`
- Test: `__tests__/path-discovery.test.ts`

**Interfaces:**

- Consumes: `process.env['SystemRoot']`, `process.env['ProgramFiles']`, `process.env['ProgramFiles(x86)']`, `process.env['ProgramData']`
- Produces: `isUnsafeCwdPath` respecting the active Windows system drives

- [ ] **Step 1: Write the failing test**

In `__tests__/path-discovery.test.ts`, add a test testing dynamic Windows system roots:

```ts
import { isUnsafeCwdPath } from '../src/core/path-discovery.ts';

describe('isUnsafeCwdPath Windows roots', () => {
  it('flags custom system root drive as unsafe on Windows', () => {
    if (process.platform !== 'win32') return;
    const sysRoot = process.env['SystemRoot'] ?? 'C:\\Windows';
    assert.strictEqual(isUnsafeCwdPath(join(sysRoot, 'System32')), true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails or exposes hardcoded behavior**

Verify with custom simulated environment paths in `__tests__/path-discovery.test.ts`.

- [ ] **Step 3: Implement dynamic system root resolution in `src/core/path-discovery.ts`**

Replace hardcoded `C:\` array with environment-derived list:

```ts
function getWindowsSystemDirs(): string[] {
  const dirs = new Set<string>();
  const addIfSet = (envVar: string, fallback: string) => {
    const val = process.env[envVar] || fallback;
    if (val) dirs.add(val);
  };
  addIfSet('SystemRoot', 'C:\\Windows');
  addIfSet('ProgramFiles', 'C:\\Program Files');
  addIfSet('ProgramFiles(x86)', 'C:\\Program Files (x86)');
  addIfSet('ProgramData', 'C:\\ProgramData');
  return [...dirs];
}

const UNSAFE_SYSTEM_DIRS = withRealSpellings(
  IS_WINDOWS
    ? getWindowsSystemDirs()
    : ['/usr', '/etc', '/bin', '/sbin', '/System', '/proc', '/sys', '/dev', '/boot'],
);
```

- [ ] **Step 4: Update `CHANGELOG.md`**

Under `## [Unreleased]` / `### Fixed`:
`- **Path guard**: dynamically discover Windows system directory roots from environment variables rather than assuming drive C.`

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test __tests__/path-discovery.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/core/path-discovery.ts __tests__/path-discovery.test.ts CHANGELOG.md
git commit -m "fix(core): dynamically resolve Windows system directories for unsafe path check"
```

---

### Task 4: Add duplicate directory and file-directory collision validation to `create`

**Finding 4:** `CreateInputSchema.superRefine` only checks for duplicates in `files`. It does not check for duplicates in `directories`, nor does it check if the same path is specified in both `directories` and `files`. When both are passed, `create` creates the directory first and then crashes with `EISDIR`/`EPERM` when trying to atomic-write the file.

**Files:**

- Modify: `src/tools/create.ts:85-100`
- Modify: `CHANGELOG.md`
- Test: `__tests__/create.test.ts`

**Interfaces:**

- Consumes: `isEquivalentPath`
- Produces: Zod issues for duplicate directories and directory-file path collisions

- [ ] **Step 1: Write the failing test**

In `__tests__/create.test.ts`, add tests for directory duplicates and collisions:

```ts
it('rejects duplicate directory entries in create batch', async () => {
  const issues = await schemaIssues(
    create({
      directories: [join(root, 'dup-dir'), join(root, 'dup-dir')],
    }),
  );
  assert.ok(
    issues.some((m) => m.includes('duplicate of directories[0]')),
    issues.join('; '),
  );
});

it('rejects a path specified as both a directory and a file', async () => {
  const target = join(root, 'clashing-path');
  const issues = await schemaIssues(
    create({
      directories: [target],
      files: [{ path: target, content: 'test content' }],
    }),
  );
  assert.ok(
    issues.some((m) => m.includes('conflicts with directories[0]')),
    issues.join('; '),
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-name-pattern="rejects duplicate directory entries|rejects a path specified as both" __tests__/create.test.ts`
Expected: FAIL (no schema issues produced).

- [ ] **Step 3: Implement validation in `CreateInputSchema.superRefine` in `src/tools/create.ts`**

In `src/tools/create.ts:85-100`:

1. Check duplicates within `directories`:

```ts
const dirs = value.directories ?? [];
for (const [index, dir] of dirs.entries()) {
  const first = dirs.findIndex((other) => isEquivalentPath(other, dir));
  if (first < index) {
    ctx.addIssue({
      code: 'custom',
      path: ['directories', index],
      message: `duplicate of directories[${String(first)}]; one entry per directory`,
      input: value,
    });
  }
}
```

2. Check collisions between `files` and `directories`:

```ts
for (const [fileIndex, file] of files.entries()) {
  const dirIndex = dirs.findIndex((dir) => isEquivalentPath(dir, file.path));
  if (dirIndex !== -1) {
    ctx.addIssue({
      code: 'custom',
      path: ['files', fileIndex, 'path'],
      message: `conflicts with directories[${String(dirIndex)}]; path cannot be both a file and a directory`,
      input: value,
    });
  }
}
```

- [ ] **Step 4: Update `CHANGELOG.md`**

Under `## [Unreleased]` / `### Fixed`:
`- **Create tool validation**: validate against duplicate directory paths and file/directory name collisions before executing batch creation.`

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test --test-name-pattern="rejects duplicate directory entries|rejects a path specified as both" __tests__/create.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/tools/create.ts __tests__/create.test.ts CHANGELOG.md
git commit -m "fix(create): reject duplicate directories and directory-file collisions"
```

---

### Task 5: Prevent rejection payload leakage in `runExclusive`

**Finding 5:** `runExclusive` chains promises using `.then(fn, fn)`. When the previous promise rejects, the second `.then` callback passes the rejection reason `err` into `fn(err)`. If `fn` takes optional parameters, it receives the error object unexpectedly.

**Files:**

- Modify: `src/core/concurrency.ts:12-24`
- Modify: `CHANGELOG.md`
- Test: `__tests__/concurrency.test.ts`

**Interfaces:**

- Consumes: `exclusiveChains`
- Produces: `runExclusive<T>(key: unknown, fn: () => Promise<T>): Promise<T>` without argument leakage

- [ ] **Step 1: Write the failing test**

In `__tests__/concurrency.test.ts`, add a test for `runExclusive`:

```ts
import { runExclusive } from '../src/core/concurrency.ts';

describe('runExclusive argument isolation', () => {
  it('does not pass previous rejection reason as an argument to the next caller', async () => {
    const key = 'test-lock-key';
    let receivedArg: unknown = 'initial';

    const failingTask = runExclusive(key, async () => {
      throw new Error('previous failure');
    });

    const nextTask = runExclusive(key, async (optionalArg?: unknown) => {
      receivedArg = optionalArg;
      return 'success';
    });

    await assert.rejects(failingTask, { message: 'previous failure' });
    const result = await nextTask;
    assert.strictEqual(result, 'success');
    assert.strictEqual(receivedArg, undefined, 'expected optionalArg to be undefined');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-name-pattern="does not pass previous rejection reason" __tests__/concurrency.test.ts`
Expected: FAIL (`AssertionError: [Error: previous failure] == undefined`)

- [ ] **Step 3: Fix `runExclusive` callback invocation in `src/core/concurrency.ts`**

In `src/core/concurrency.ts:13`:

```ts
export async function runExclusive<T>(key: unknown, fn: () => Promise<T>): Promise<T> {
  const previous = exclusiveChains.get(key) ?? Promise.resolve();
  const run = previous.then(
    () => fn(),
    () => fn(),
  );
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  exclusiveChains.set(key, tail);
  try {
    return await run;
  } finally {
    if (exclusiveChains.get(key) === tail) exclusiveChains.delete(key);
  }
}
```

- [ ] **Step 4: Update `CHANGELOG.md`**

Under `## [Unreleased]` / `### Fixed`:
`- **Concurrency lock queue**: isolate subsequent exclusive tasks from preceding rejection reasons so optional parameters are not populated with error objects.`

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test --test-name-pattern="does not pass previous rejection reason" __tests__/concurrency.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/core/concurrency.ts __tests__/concurrency.test.ts CHANGELOG.md
git commit -m "fix(core): prevent rejection payload leak into callbacks in runExclusive"
```

---

### Task 6: Precompute basename when sorting search results in `find_files`

**Finding 6:** In `src/tools/find-files.ts:143-145`, `results.toSorted((x, y) => basename(x).localeCompare(basename(y)))` executes `basename()` on every comparison. For 10,000 matches, this invokes `basename()` up to 280,000 times during sort.

**Files:**

- Modify: `src/tools/find-files.ts:141-146`
- Test: `__tests__/find-files.test.ts`

**Interfaces:**

- Consumes: `basename`, `results`
- Produces: Sorted file paths without repeated basename extraction

- [ ] **Step 1: Write verification test**

In `__tests__/find-files.test.ts`, confirm existing sorting test passes:
Run: `node --test --test-name-pattern="sortBy 'name' orders by basename" __tests__/find-files.test.ts`
Expected: PASS

- [ ] **Step 2: Optimize basename sorting in `src/tools/find-files.ts`**

In `src/tools/find-files.ts:141-146`:

```ts
// Sorted after the scan, on the kept results.
const found =
  args.sortBy === 'name'
    ? results
        .map((path) => ({ path, name: basename(path) }))
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((item) => item.path)
    : results.toSorted((x, y) => x.localeCompare(y));
```

- [ ] **Step 3: Run tests to verify sorting behavior is preserved**

Run: `node --test __tests__/find-files.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/tools/find-files.ts
git commit -m "perf(find_files): precompute basename for name-based search result sorting"
```

---

### Task 7: Cache parent directory on `CollectedEntry` in `list`

**Finding 7:** In `src/tools/list.ts:80-93`, `entryComparator` calls `parentOf(a)` and `parentOf(b)` on every comparison, repeatedly scanning and slicing strings for up to 40,000 items.

**Files:**

- Modify: `src/tools/list.ts:55-95`
- Test: `__tests__/list.test.ts`

**Interfaces:**

- Consumes: `CollectedEntry`
- Produces: `CollectedEntry.parent` property populated once during entry creation

- [ ] **Step 1: Write verification test**

Run: `node --test --test-name-pattern="orders files largest first" __tests__/list.test.ts`
Expected: PASS

- [ ] **Step 2: Add `parent` property to `CollectedEntry` and update comparator in `src/tools/list.ts`**

1. In `CollectedEntry` interface (`src/tools/list.ts`):

```ts
interface CollectedEntry {
  readonly path: string;
  readonly relativePath: string;
  readonly parent: string;
  readonly name: string;
  readonly type: 'file' | 'directory';
  readonly size?: number;
  readonly modified?: string;
}
```

2. When constructing `CollectedEntry` in `buildEntry`:

```ts
const slash = relativePath.lastIndexOf('/');
const parent = slash === -1 ? '' : relativePath.slice(0, slash);
return {
  path,
  relativePath,
  parent,
  name,
  type,
  ...(size !== undefined ? { size } : {}),
  ...(modified !== undefined ? { modified } : {}),
};
```

3. In `entryComparator`:

```ts
function entryComparator(sortBy: 'name' | 'size') {
  return (a: CollectedEntry, b: CollectedEntry): number => {
    if (a.parent !== b.parent) return a.parent.localeCompare(b.parent);
    const rankDiff = Number(b.type === 'directory') - Number(a.type === 'directory');
    if (rankDiff !== 0) return rankDiff;
    if (sortBy === 'size') {
      const sizeDiff = (b.size ?? 0) - (a.size ?? 0);
      if (sizeDiff !== 0) return sizeDiff;
    }
    return a.name.localeCompare(b.name);
  };
}
```

- [ ] **Step 3: Run all list tests to verify sorting behavior**

Run: `node --test __tests__/list.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/tools/list.ts
git commit -m "perf(list): memoize parent directory on CollectedEntry for sorting"
```

---

### Task 8: Full repository check and graphify update

- [ ] **Step 1: Run graphify update**

Run: `graphify update .`

- [ ] **Step 2: Run static checks and tests**

Run: `npm run check`
Expected: Static checks, linting, formatting, and all test suites pass without regression.
