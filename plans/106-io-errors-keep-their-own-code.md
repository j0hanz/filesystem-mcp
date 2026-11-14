# Plan 106: A real I/O failure is reported as `IO_ERROR`, not as the tool's default code

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report; do not improvise. When done, update the status row for this plan
> in `plans/README.md`, unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 366c4c96..HEAD -- src/core/errors.ts __tests__/errors.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: MED (clients or tests may key on today's codes for these errnos)
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `366c4c96`, 2026-11-14

## Why this matters

Each tool declares a default error code for failures that cannot be
classified: `read` uses `NOT_FILE`, `stat` uses `NOT_FOUND`, `list` uses
`NOT_DIRECTORY`. `Problem.fromUnknown` applies that default to `UNKNOWN`
errors, which is right, but also to `IO_ERROR`, which is a classified error:
`EBUSY`, `EMFILE`, `ENFILE` and every unmapped errno (`EIO`, `EROFS`,
`ENOSPC`).

So when `read` hits a file another process holds open (`EBUSY` on Windows),
the model is told `NOT_FILE` with the hint "Target is a directory, not a
file." `stat` on the same file says `NOT_FOUND`, "Run list or find_files to
verify the path." Both send the model down the wrong path. After this plan
those failures report `IO_ERROR` with a hint that fits.

## Current state

`src/core/errors.ts:49-59`:

```ts
  fromUnknown(error: unknown, defaultCode: ErrorCode, path?: string, rows?: ErrnoRows): Problem {
    const problem = classify(error, rows);
    const shouldOverride =
      problem.code === ErrorCode.UNKNOWN || problem.code === ErrorCode.IO_ERROR;
    const code = shouldOverride ? defaultCode : problem.code;
    const suggestion =
      (shouldOverride ? DEFAULT_SUGGESTIONS[code] : undefined) ??
      problem.suggestion ??
      DEFAULT_SUGGESTIONS[problem.code];
    return build(code, problem.message, { path: path ?? problem.path, suggestion });
  },
```

`DEFAULT_SUGGESTIONS` (`src/core/errors.ts:76-87`) has no entry for
`IO_ERROR`. `ERRNO_MAP` (`:89-104`) maps `EMFILE`, `ENFILE`, `EBUSY` to
`IO_ERROR`; line 221 maps every unlisted errno to `IO_ERROR` too.

Callers that pass a non-`UNKNOWN` default: `src/tools/define.ts:330`
(`this.def.defaultErrorCode ?? ErrorCode.UNKNOWN`) and `src/tools/batch.ts:41`.
Every other caller passes `ErrorCode.UNKNOWN`, for which the override turns
`IO_ERROR` into `UNKNOWN` (also wrong, also fixed by this plan).

Tests: `__tests__/errors.test.ts` (`describe('Problem.fromUnknown with errno rows', ...)`
at line 103) uses this helper:

```ts
const errnoError = (code: string, path?: string): NodeJS.ErrnoException =>
  Object.assign(new Error(`${code}: boom`), path === undefined ? { code } : { code, path });
```

`__tests__/core-fs.test.ts:133` asserts
`Problem.fromUnknown(error, ErrorCode.NOT_FILE).code` against a table of
codes; read lines 100-140 of that file before changing anything.

## Commands you will need

| Purpose       | Command                                                     | Expected on success |
| :------------ | :---------------------------------------------------------- | :------------------ |
| One test file | `node --test --test-timeout=60000 __tests__/errors.test.ts` | all pass            |
| All tests     | `npm test`                                                  | all pass            |
| Full check    | `npm run check`                                             | exit 0              |

## Scope

**In scope**:

- `src/core/errors.ts` (`fromUnknown` and one new `DEFAULT_SUGGESTIONS` entry)
- `__tests__/errors.test.ts` (new tests)
- Any existing test that asserts the old code for an `IO_ERROR`-class errno
  (update the expectation; list each one in your report)
- `CHANGELOG.md`, `plans/README.md`

**Out of scope**:

- `ERRNO_MAP`: do not remap `ENOTEMPTY` or anything else here.
- Tool `defaultErrorCode` values in `src/tools/*.ts`.
- `__tests__/contract.test.ts.snapshot`: the error-code enum does not change.

## Git workflow

- Branch: `fix/io-errors-keep-code`
- One commit: `fix(errors): report an I/O failure as IO_ERROR instead of the tool's default code`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Write the failing tests

In `__tests__/errors.test.ts`, add inside the `Problem.fromUnknown with errno rows`
describe:

```ts
it('keeps IO_ERROR for a real I/O failure instead of the default code', () => {
  const busy = Problem.fromUnknown(errnoError('EBUSY'), ErrorCode.NOT_FILE, '/f');
  assert.strictEqual(busy.code, ErrorCode.IO_ERROR);
  assert.doesNotMatch(busy.suggestion ?? '', /directory/);
  assert.strictEqual(
    Problem.fromUnknown(errnoError('EIO'), ErrorCode.NOT_FOUND).code,
    ErrorCode.IO_ERROR,
  );
});
it('still gives an unclassified error the default code', () => {
  assert.strictEqual(Problem.fromUnknown('nope', ErrorCode.NOT_FILE).code, ErrorCode.NOT_FILE);
});
```

**Verify**: `node --test --test-timeout=60000 __tests__/errors.test.ts` → the
first new test FAILS, the second passes.

### Step 2: Narrow the override

In `fromUnknown`, change `shouldOverride` to:

```ts
const shouldOverride = problem.code === ErrorCode.UNKNOWN;
```

Add to `DEFAULT_SUGGESTIONS`:

```ts
  [ErrorCode.IO_ERROR]:
    'The operating system refused the operation (file busy, disk or handle limit). Retry; if it repeats, tell the person.',
```

**Verify**: `node --test --test-timeout=60000 __tests__/errors.test.ts` → all pass.

### Step 3: Reconcile existing expectations

Run `npm test`. For each failure, decide:

- The test injects an `IO_ERROR`-class errno (`EBUSY`, `EMFILE`, `ENFILE`,
  `EIO`, or another errno missing from `ERRNO_MAP`) and asserts the tool's
  default code → update the expectation to `IO_ERROR` and record the test
  name in your report.
- Anything else → STOP.

**Verify**: `npm test` → all pass.

### Step 4: Changelog and full check

Under `## [Unreleased]` → `### Changed` in `CHANGELOG.md`:

```md
- **Errors**: an operating-system failure such as a busy file (`EBUSY`), a handle limit or a disk error now reports `IO_ERROR` in every tool; before, `read` reported it as `NOT_FILE`, `stat` as `NOT_FOUND` and `list` as `NOT_DIRECTORY`, with a hint for the wrong problem.
```

**Verify**: `npm run check` → exit 0.

## Test plan

- Two new unit tests (Step 1).
- Existing expectations updated in Step 3, each listed in the report.

## Done criteria

- [ ] `npm run check` exits 0
- [ ] `grep -n "ErrorCode.IO_ERROR;" src/core/errors.ts` no longer shows the `shouldOverride` line
- [ ] Report lists every existing test whose expectation changed
- [ ] `plans/README.md` status row updated

## STOP conditions

- `fromUnknown` does not match the excerpt.
- More than 10 existing tests fail after Step 2, or a failing test is not
  about an `IO_ERROR`-class errno. The override may be load-bearing somewhere
  this plan did not anticipate.
- A test asserts that `EBUSY` on a _walked_ entry is counted as inaccessible
  and that changes. Scan skipping uses `isSkippable`, not `fromUnknown`; it
  must be unaffected.

## Maintenance notes

- This is a client-visible change of `code` for a small class of failures.
  The reviewer should confirm the CHANGELOG line is under `Changed`.
- `ENOTEMPTY` still maps to `NOT_DIRECTORY` outside `delete`
  (`src/core/errors.ts:101`). That is a separate, smaller wrong-hint issue
  left for a later plan.
