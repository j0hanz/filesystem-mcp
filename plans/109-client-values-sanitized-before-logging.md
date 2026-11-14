# Plan 109: Client-supplied URIs are made safe before they reach a log line

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report; do not improvise. When done, update the status row for this plan
> in `plans/README.md`, unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 366c4c96..HEAD -- src/core/watcher-registry.ts src/resources.ts src/core/observability.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `366c4c96`, 2026-11-14

## Why this matters

The server logs to stderr, one event per line. Several log calls interpolate
a resource URI exactly as the client sent it, before the URI is parsed or
validated. A URI containing a line break lets a client forge extra log lines
(for example a fake `[error]` entry); a multi-megabyte URI floods one line.
The repo already has the fix for this, `sanitizeLogField`, but only
`src/tools/define.ts` uses it.

## Current state

`src/core/observability.ts:23-25`:

```ts
export function sanitizeLogField(value: string, max = 128): string {
  return value.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ').slice(0, max);
}
```

`Logger.warn`/`Logger.error` pass the message straight to `console.error`
(`src/core/observability.ts:9-13`); nothing is escaped.

Unsanitized sites in `src/core/watcher-registry.ts`:

```ts
// :16-18
function warnWatcherCap(uri: string): void {
  Logger.warn(`Cannot subscribe to ${uri}: MAX_WATCHERS limit (${MAX_WATCHERS}) reached.`);
}
// :116
Logger.warn(`Notify callback error for ${uri}: ${formatUnknownErrorMessage(err)}`);
// :187
Logger.warn(`Watcher error for ${uri}: ${err.message}`);
// :201
Logger.error(`Failed to create watcher for ${uri}: ${formatUnknownErrorMessage(err)}`);
```

`warnWatcherCap(uri)` is called at `:252`, before `extractPath(uri)` at
`:256`, so the URI there is whatever string the client sent.

In `src/resources.ts:330-332`:

```ts
Logger.warn(
  `Unexpected error validating path for watcher ${uri}: ${formatUnknownErrorMessage(err)}`,
);
```

Exemplar of correct use, `src/tools/define.ts:294-299`:

```ts
const trace = typeof traceparent === 'string' ? ` ${sanitizeLogField(traceparent)}` : '';
// ...
const text = sanitizeLogField(msg, Infinity);
```

Test pattern for spying on logs: `t.mock.method(console, 'error', (...args: unknown[]) => { ... })`
(for example `__tests__/http-policy.test.ts:835`). `__tests__/observability.test.ts`
tests `sanitizeLogField` itself.

## Commands you will need

| Purpose       | Command                                                            | Expected on success |
| :------------ | :----------------------------------------------------------------- | :------------------ |
| Build         | `npm run build`                                                    | exit 0              |
| One test file | `node --test --test-timeout=60000 __tests__/observability.test.ts` | all pass            |
| Full check    | `npm run check`                                                    | exit 0              |

## Scope

**In scope**:

- `src/core/watcher-registry.ts` (the four log calls above)
- `src/resources.ts` (the one log call above)
- `__tests__/observability.test.ts` (one new test)
- `plans/README.md`

**Out of scope**:

- `src/core/observability.ts`: do not sanitize inside `write()`. Some
  messages are multi-line on purpose and error objects are passed as extra
  arguments.
- Error text sent to the client (`src/resources.ts:500`,
  `src/transport/stdio.ts:389`): a separate question, not this plan.
- `src/transport/http.ts`.

## Git workflow

- Branch: `fix/sanitize-logged-uris`
- One commit: `fix(logging): sanitize client-supplied URIs before logging them`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Sanitize at the five sites

In `src/core/watcher-registry.ts`, extend the existing import from
`./observability.ts` with `sanitizeLogField` and add one module-level helper:

```ts
/** A client-supplied URI, safe for one log line. */
const shownUri = (uri: string): string => sanitizeLogField(uri, 256);
```

Replace `${uri}` with `${shownUri(uri)}` in the four log calls listed above.
In the `:187` call also wrap the message: `${sanitizeLogField(err.message, 256)}`.
Do not touch any other use of `uri` (map keys, callbacks).

In `src/resources.ts`, import `sanitizeLogField` from
`./core/observability.ts` (the file already imports `Logger` from there) and
change the call to
`` `Unexpected error validating path for watcher ${sanitizeLogField(uri, 256)}: ${formatUnknownErrorMessage(err)}` ``.

**Verify**: `npm run build` → exit 0.
**Verify**: `grep -n 'for \${uri}\|to \${uri}\|watcher \${uri}' src/core/watcher-registry.ts src/resources.ts`
→ no matches.

### Step 2: Test

The cap warning is the one site reachable without a real watcher failure,
but reaching it needs `MAX_WATCHERS` (256) live watchers. Use the cheaper,
direct assertion instead: add to `__tests__/observability.test.ts` a test
that imports `createWatcherRegistry` from `../src/core/watcher-registry.ts`,
spies `console.error` with `t.mock.method`, and drives a log line through a
path that needs no watcher:

- Call `registry.acquire(guard, 'not-a-file-uri\n[error] forged', () => {})`
  is NOT enough (a bad URI returns before logging). Instead fill the registry
  to the cap: create one temp directory with `createTestRoot()`, build a
  guard with `makeGuard([dir])` from `__tests__/helpers.ts`, then acquire
  `MAX_WATCHERS` distinct directory URIs. Creating 256 sub-directories and
  watching each is acceptable; build each URI with `pathToFileURL(sub).href`.
- Then call `acquire` once more with the URI string
  `` `${pathToFileURL(dir).href}/x\n[error] forged line` `` and assert:
  the result is `{ ok: false, reason: 'capped' }`; exactly one `console.error`
  call contains `Cannot subscribe to`; that call's first argument contains no
  `\n`.
- Release every lease in a `finally` (`registry.release(uri)` per acquired
  URI) and remove the temp directory with `cleanupTestRoot`.

Read `makeGuard`'s signature in `__tests__/helpers.ts` before using it.

**Verify**: `node --test --test-timeout=60000 __tests__/observability.test.ts` → all pass.
Temporarily revert Step 1's change to `warnWatcherCap` and confirm the new
test fails; then restore it.

### Step 3: Full check

**Verify**: `npm run check` → exit 0.

## Test plan

- One new test (Step 2), proving the cap warning is a single line.
- The other four sites are covered by the grep in Step 1; they need a real
  `fs.watch` failure to reach and are not worth a fixture.

## Done criteria

- [ ] `npm run check` exits 0
- [ ] The grep in Step 1 returns nothing
- [ ] The new test fails without the fix and passes with it
- [ ] `plans/README.md` status row updated

## STOP conditions

- Acquiring `MAX_WATCHERS` watchers fails on your platform before the cap
  (for example Linux inotify limits) or takes more than 10 seconds. Report;
  the reviewer may accept the grep as the only check.
- A log call listed in "Current state" is gone or reworded.

## Maintenance notes

- New log calls that interpolate anything from a request (URI, id, header,
  tool argument) should use `sanitizeLogField`. A lint rule for this is not
  worth its cost today.
- No CHANGELOG entry: log text is not part of the contract
  (`docs/mutation-triage.md`, "Error and log text").
