# Plan 016: Error messages and comments name the settings that actually exist

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 1eb94134..HEAD -- src/core/path.ts src/transport/http-policy.ts src/transport/shared.ts src/transport/http.ts src/server.ts src/tools/define.ts src/core/observability.ts __tests__/security.test.ts __tests__/http-policy.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition. (Plans 013 and 017 also edit
> `src/transport/http.ts` / `src/transport/http-policy.ts` on other lines; if
> they landed first, only re-check the exact lines this plan quotes.)

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `1eb94134`, 2026-09-26

## Why this matters

Commit `9d26984c` (`feat!: unify env config under FS_ prefix`) renamed every
environment variable to an `FS_`-prefixed name, and an unprefixed `API_KEY`
is now deliberately ignored (a test pins that). Three runtime messages still
name the old variables:

- The error a model sees on every sensitive-file denial says
  `Set ALLOW_SENSITIVE=1 to override.` Nothing reads `ALLOW_SENSITIVE`; the
  real settings are `--allow-sensitive` / `FS_ALLOW_SENSITIVE`.
- The two HTTP bind-policy errors an operator sees at startup say `API_KEY`.
  Nothing reads `API_KEY`; the real settings are `--api-key` / `FS_API_KEY`.

An operator following either message sets a variable that does nothing. A
handful of code comments carry the same stale names (`API_KEY`, `HTTP_HOST`,
`LOG_LEVEL`) and mislead maintainers the same way. This plan fixes the three
messages, pins them with test assertions, and corrects the comments.

## Current state

The real names (verified): `src/cli.ts:146` reads `FS_HTTP_HOST`,
`src/cli.ts:147` reads `FS_API_KEY`, `src/core/sensitive.ts:301` reads
`FS_ALLOW_SENSITIVE`, `src/core/observability.ts:45` reads `FS_LOG_LEVEL`.
The CLI flags are `--allow-sensitive` (`src/cli.ts:104`), `--api-key`,
`--http-host`, `--log-level`. `parseTrueEnvFlag`
(`src/core/path-utils.ts:51-59`) accepts `true` or `1`.

Runtime messages to fix:

```ts
// src/core/path.ts:618-626 — the single throw site for every sensitive-file denial
  private assertNotSensitiveFile(checkPath: string, requestedPath: string): void {
    if (this.isSensitive(checkPath)) {
      throw new FsError(
        ErrorCode.ACCESS_DENIED,
        'Sensitive file blocked. Set ALLOW_SENSITIVE=1 to override.',
        requestedPath,
      );
    }
  }
```

```ts
// src/transport/http-policy.ts:122-137
export function assertHttpBindingPolicy(host: string, apiKey: string | undefined): void {
  if (isLoopbackHttpHost(host)) {
    if (apiKey !== undefined && !isSecureApiKey(apiKey)) {
      throw new FsError(
        ErrorCode.PERMISSION_DENIED,
        'API_KEY is configured but is insecure (minimum 16 characters).',
      );
    }
    return;
  }
  if (isSecureApiKey(apiKey)) return;
  throw new FsError(
    ErrorCode.PERMISSION_DENIED,
    `Refusing to bind HTTP server to non-loopback host '${host}' without a secure API_KEY (minimum 16 characters).`,
  );
}
```

Existing tests that match these messages (must keep passing — keep the
matched fragments):

- `__tests__/http-policy.test.ts:274` —
  `assert.match(err.message, /Refusing to bind HTTP server to non-loopback host/);`
  (in `TC-SEC-026`)
- `__tests__/http-policy.test.ts:315` — `assert.match(err.message, /insecure/);`
  (in `TC-SEC-027`)
- `__tests__/security.test.ts:85-96` — `TC-SEC-008` asserts only
  `err.code === ErrorCode.ACCESS_DENIED` for a `.env` file; it does not check
  the message yet.

Stale names in comments (found with
`grep -rnwE "API_KEY|HTTP_HOST|LOG_LEVEL|ALLOW_SENSITIVE" src` — `-w` skips
the correct `FS_`-prefixed spellings because `_` is a word character):

| File:line                          | Stale text                              | Correct text                    |
| :--------------------------------- | :-------------------------------------- | :------------------------------ |
| `src/transport/shared.ts:22`       | ``/** `--http-host` or `HTTP_HOST`. …`` | `` `FS_HTTP_HOST` ``            |
| `src/transport/shared.ts:24`       | ``/** `--api-key` or `API_KEY`. …``     | `` `FS_API_KEY` ``              |
| `src/server.ts:66`                 | ``from `--api-key` or `API_KEY`.``      | `` `FS_API_KEY` ``              |
| `src/transport/http.ts:286`        | `with API_KEY set`                      | `with FS_API_KEY set`           |
| `src/transport/http-policy.ts:199` | `` `API_KEY` is a ``                    | `` `FS_API_KEY` is a ``         |
| `src/tools/define.ts:51`           | ``gated by `LOG_LEVEL`.``               | `` `FS_LOG_LEVEL` ``            |
| `src/core/observability.ts:34`     | `// LOG_LEVEL — the initial`            | `// FS_LOG_LEVEL — the initial` |

`README.md`, `CONTRIBUTING.md`, `docs/adr/`, `mcpb/manifest.json`,
`server.json` and `Dockerfile` were checked: they already use the `FS_`
names.

## Commands you will need

| Purpose      | Command                | Expected on success |
| ------------ | ---------------------- | ------------------- |
| Static check | `npm run check:static` | exit 0              |
| All tests    | `npm test`             | all pass            |

Two more commands, outside the table because they contain `|`, which a
Markdown table would force to be escaped. Copy them exactly as written here:

```bash
npm test -- --test-name-pattern="TC-SEC-008|TC-SEC-02[67]"
grep -rnwE "API_KEY|HTTP_HOST|LOG_LEVEL|ALLOW_SENSITIVE" src
```

`npm run check:static` = build + `tsc -p tsconfig.test.json` + eslint
(`--max-warnings=0`) + `prettier --check .` + knip. Run the grep from Git
Bash (or any POSIX shell) at the repo root.

## Scope

**In scope** (the only files you should modify):

- `src/core/path.ts` — the message string at line 622 only
- `src/transport/http-policy.ts` — the two message strings (lines 127, 135)
  and the comment at line 199
- `src/transport/shared.ts`, `src/server.ts`, `src/transport/http.ts`,
  `src/tools/define.ts`, `src/core/observability.ts` — the comment lines in
  the table above only
- `__tests__/security.test.ts`, `__tests__/http-policy.test.ts` — added
  assertions
- `plans/README.md` (status row)

**Out of scope** (do NOT touch, even though they look related):

- Any code logic, error code, or control flow — this plan changes strings and
  comments only.
- `src/cli-help.ts` and `README.md` — already correct.
- `CHANGELOG.md` history entries that mention the old names — they describe
  past releases.
- The `DEFAULT_SUGGESTIONS` entry for `ACCESS_DENIED` in
  `src/core/errors.ts` — a separate, generic hint.
- Other stale comments found in the same audit (ADR line anchors, comments in
  `list.ts`, `http.ts:240-243`, `server.ts:78-81`) — not part of this plan.

## Git workflow

- Branch: `advisor/016-real-env-names` from `main`.
- One commit for messages and tests, one for comments, conventional-commit
  style matching the log, for example
  `fix(errors): name FS_ALLOW_SENSITIVE and FS_API_KEY in refusal messages`
  and `docs(src): correct stale unprefixed env names in comments`.
- End each commit message with the attribution line the operator's
  environment requires, if any.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Pin the correct names in tests (they must fail now)

1. `__tests__/security.test.ts`, test `TC-SEC-008` (lines 85-96): inside the
   `assert.rejects` validator, after
   `assert.strictEqual(err.code, ErrorCode.ACCESS_DENIED);`, add:

   ```ts
   assert.match(err.message, /--allow-sensitive/);
   assert.match(err.message, /FS_ALLOW_SENSITIVE=1/);
   ```

2. `__tests__/http-policy.test.ts`, test `TC-SEC-026`: in the first
   `assert.throws` validator (the one at line 274 matching
   `/Refusing to bind HTTP server to non-loopback host/`), add after that
   line:

   ```ts
   assert.match(err.message, /FS_API_KEY/);
   ```

3. `__tests__/http-policy.test.ts`, test `TC-SEC-027`: in the first
   `assert.throws` validator (the one at line 315 matching `/insecure/`), add
   after that line:

   ```ts
   assert.match(err.message, /FS_API_KEY/);
   ```

**Verify**: `npm test -- --test-name-pattern="TC-SEC-008|TC-SEC-02[67]"` →
exactly these three tests **fail** on the new assertions (the messages still
say `ALLOW_SENSITIVE=1` / `API_KEY`). If any of them passes, STOP.

### Step 2: Fix the three runtime messages

1. `src/core/path.ts:622` → replace the string with:

   ```ts
        'Sensitive file blocked. Start the server with --allow-sensitive (or FS_ALLOW_SENSITIVE=1) to override.',
   ```

2. `src/transport/http-policy.ts:127` → replace the string with:

   ```ts
          'The configured API key (--api-key / FS_API_KEY) is insecure (minimum 16 characters).',
   ```

3. `src/transport/http-policy.ts:135` → replace the template literal with:

   ```ts
      `Refusing to bind HTTP server to non-loopback host '${host}' without a secure API key (set --api-key or FS_API_KEY, minimum 16 characters).`,
   ```

   The fragments the existing tests match (`insecure`,
   `Refusing to bind HTTP server to non-loopback host`) are preserved.

4. Run `npx prettier --write src/core/path.ts src/transport/http-policy.ts`
   (a longer string may re-wrap).

**Verify**: `npm test -- --test-name-pattern="TC-SEC-008|TC-SEC-02[67]"` →
all three pass.

### Step 3: Correct the stale names in comments

Apply each row of the table in "Current state": change only the variable
name inside the comment, keep the rest of the sentence. Do not touch any
non-comment code.

**Verify**:
`grep -rnwE "API_KEY|HTTP_HOST|LOG_LEVEL|ALLOW_SENSITIVE" src` → no output.

### Step 4: Full gate

**Verify**: `npm run check` → exit 0; all tests pass.

## Test plan

- `TC-SEC-008` gains two message assertions (`--allow-sensitive`,
  `FS_ALLOW_SENSITIVE=1`).
- `TC-SEC-026` and `TC-SEC-027` each gain `FS_API_KEY`.
- The `grep -rnwE …` command above is the guard for the comment fixes and
  for any unprefixed name that reappears in `src/`.

## Done criteria

ALL must hold:

- [ ] `npm run check` exits 0
- [ ] `grep -rnwE "API_KEY|HTTP_HOST|LOG_LEVEL|ALLOW_SENSITIVE" src` prints nothing
- [ ] The three strengthened tests pass
- [ ] `git diff --stat` shows only the in-scope files, and
      `git diff -- src/ | grep '^[-+]' | grep -vE '^(\+\+\+|---)'` shows only
      string-literal and comment lines
- [ ] `plans/README.md` status row for 016 updated

## STOP conditions

Stop and report back (do not improvise) if:

- The drift check shows a quoted line changed and no longer matches.
- Any Step 1 assertion passes before Step 2 — the message was already fixed
  some other way; report instead of editing.
- Another test in the suite matches the old message text and breaks after
  Step 2 (search `__tests__/` for the old phrase before changing it). Report
  the test name; do not weaken it.
- The grep in Step 3 finds a stale name outside the table's lines. Report the
  location instead of guessing whether it is a comment.
- A step's verification fails twice after a reasonable fix attempt.

## Maintenance notes

- Operator-facing messages should name both the CLI flag and the `FS_`
  environment variable, matching `src/cli-help.ts`. The next rename of a
  setting must grep `src/` for message strings too, not just `process.env`
  reads.
- The `grep -rnwE` guard is cheap. Consider adding it to CI (a knip-style
  check) if env renames recur. That is deferred as out of scope here.
