# Plan 053: `FS_ALLOWED_ORIGINS` documents browser-extension origins (`<scheme>://*` and extension IDs), which the gate already accepts

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report; do not improvise. When done, update the status row for this plan
> in `plans/README.md`, unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 8941498f..HEAD -- README.md src/cli-help.ts __tests__/http-policy.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW. Documentation plus a unit test that pins behaviour the SDK
  already has; no runtime code changes.
- **Depends on**: none
- **Category**: docs
- **Planned at**: commit `8941498f`, 2026-10-09

## Why this matters

`@modelcontextprotocol/server` 2.3.0 taught `validateOriginHeader` (and so
the `originValidation` gate this server mounts) two allowlist forms beyond
plain hostnames: a lowercase `<scheme>://*` entry such as `moz-extension://*`
admits every origin of that scheme (Firefox extension IDs differ per
install), and a bare extension ID admits one Chromium extension, because an
extension origin's hostname is its ID. This server already passes
`FS_ALLOWED_ORIGINS` straight through to that gate and to its own CORS
reflection, so both forms work end to end today. But README and `--help`
still say "origin hostnames", so an operator wiring up a browser-extension
MCP client has no way to know. One table cell, one help string and one test
close that gap; the test also guards against a future SDK change silently
removing the behaviour this documentation promises.

## Current state

- `src/transport/http.ts:90,101-108` reads the variable and mounts the SDK
  gate over the list unchanged:

```ts
  const allowedOriginHostnames = computeAllowedOriginHostnames(process.env['FS_ALLOWED_ORIGINS']);
  …
  if (allowedOriginHostnames.length > 0) {
    app.use(originValidation(allowedOriginHostnames));
  } else if (isLoopbackHttpHost(httpHost)) {
```

- `src/transport/http-policy.ts:318-324` splits the CSV with `splitCsvList`
  (`src/core/util.ts:51-56`: split on `,`, trim, drop empties; no
  lowercasing, no parsing):

```ts
export function computeAllowedOriginHostnames(originsEnv: string | undefined): string[] {
  …
  return originsEnv ? splitCsvList(originsEnv) : localhostAllowedOrigins();
}
```

- `src/transport/http-policy.ts:88-91` is the CORS-reflection check, built
  on the same SDK validator, so reflection matches admission:

```ts
export function isOriginAllowed(origin: string, allowedHostnames: readonly string[]): boolean {
  const allowed = allowedHostnames.length > 0 ? [...allowedHostnames] : localhostAllowedOrigins();
  return origin !== '' && validateOriginHeader(origin, allowed).ok;
}
```

- The SDK contract (installed `@modelcontextprotocol/server` 2.3.1,
  `node_modules/@modelcontextprotocol/server/dist/index.d.mts:324-336`):

  > Allowlist items are hostnames only (no scheme, no port) … A browser
  > extension's origin carries its extension ID as the hostname; list the ID
  > to allow one extension. An allowlist item of the form `<scheme>://*`
  > (lowercase, e.g. `moz-extension://*`) allows every origin of that scheme
  > … `http://*` and `https://*` are not honoured: list websites by hostname.

  Verified at planning time against the installed runtime with
  `node -e "import('@modelcontextprotocol/server').then(m => console.log(m.validateOriginHeader('moz-extension://abc', ['moz-extension://*']).ok))"`:
  `moz-extension://abc` vs `['moz-extension://*']` → `ok: true`;
  `chrome-extension://abc` vs `['moz-extension://*']` → `ok: false`;
  `https://evil.com` vs `['https://*']` → `ok: false`;
  `chrome-extension://abcdef` vs `['abcdef']` → `ok: true`;
  `moz-extension://abc` vs `['MOZ-EXTENSION://*']` → `ok: false` (case-sensitive).
  The same wildcard note is in `node_modules/@modelcontextprotocol/express/dist/index.d.mts:35,119`.

- `README.md:454`, the env-var table row (one line, Prettier-aligned table):

```md
| `FS_ALLOWED_ORIGINS` | Comma-separated origin hostnames allowed to call `/mcp` from a browser. Replaces the localhost default, so also list `localhost`, `127.0.0.1` or `[::1]` if local browser clients still need access. |
```

- `src/cli-help.ts:105`:

```ts
  { flags: 'FS_ALLOWED_ORIGINS', desc: 'Comma-separated origin hostnames for CORS' },
```

- `__tests__/http-policy.test.ts:321-399`, `describe('CORS and Origin Policy (TC-SEC-028 - TC-SEC-031)')`.
  `TC-SEC-030` (`:381-399`) is the exemplar: direct `isOriginAllowed(origin, list)`
  assertions, no server boot. `isOriginAllowed` and
  `computeAllowedOriginHostnames` are already imported (`:13,17`).

Conventions: README env table is a Prettier-formatted markdown table (the
whole row re-aligns when a cell changes; run Prettier rather than
hand-padding). Test names carry a `TC-SEC-NNN` id; use `TC-SEC-030b` for the
new case to stay inside this block's numbering.

## Commands you will need

| Purpose      | Command                                     | Expected on success |
| ------------ | ------------------------------------------- | ------------------- |
| Static check | `npm run check:static`                      | exit 0              |
| Policy tests | `npm test -- __tests__/http-policy.test.ts` | all pass            |
| Help output  | `node src/index.ts --help`                  | prints the new text |
| Full check   | `npm run check`                             | exit 0; `fail 0`    |
| Format       | `npx prettier --write <files you edited>`   | exit 0              |

Baseline at planning time: `npm test` → 567 tests, 564 pass, 3 skipped, 0 fail.

## Scope

**In scope** (the only files you should modify):

- `README.md` (one table cell)
- `src/cli-help.ts` (one string)
- `__tests__/http-policy.test.ts` (one new test)
- `plans/README.md` (status row)

**Out of scope** (do NOT touch, even though they look related):

- `src/transport/http.ts`, `src/transport/http-policy.ts`,
  `src/core/util.ts`: the behaviour exists; do not add parsing, lowercasing
  or validation of the entries. Lowercasing in particular would be wrong for
  hostnames that the SDK compares as given.
- `src/instructions.ts` and the instructions resource: they describe tool
  behaviour for the model, not operator transport configuration.
- `docs/adr/*`: no decision changes.

## Git workflow

- Branch: `advisor/053-allowed-origins-extension-forms`
- One commit, e.g. `docs(http): FS_ALLOWED_ORIGINS accepts <scheme>://* and extension IDs`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Pin the behaviour

In `__tests__/http-policy.test.ts`, directly after `TC-SEC-030` (ends at
line 399, inside the `'CORS and Origin Policy'` describe), add:

```ts
it('TC-SEC-030b: an allowlist entry may be a lowercase <scheme>://* or a bare extension ID', () => {
  // Firefox extension IDs differ per install, so the scheme wildcard is
  // the only way to admit one; Chromium IDs are stable, so the ID alone
  // (the origin's hostname) admits exactly that extension.
  assert.strictEqual(isOriginAllowed('moz-extension://abc123', ['moz-extension://*']), true);
  assert.strictEqual(isOriginAllowed('chrome-extension://abcdefghijkl', ['abcdefghijkl']), true);
  // The wildcard is scheme-exact and lowercase-only.
  assert.strictEqual(isOriginAllowed('chrome-extension://abc123', ['moz-extension://*']), false);
  assert.strictEqual(isOriginAllowed('moz-extension://abc123', ['MOZ-EXTENSION://*']), false);
  // Web schemes never wildcard: sites are listed by hostname.
  assert.strictEqual(isOriginAllowed('https://evil.com', ['https://*']), false);
  assert.strictEqual(isOriginAllowed('http://evil.com', ['http://*']), false);
  // The env parser passes such entries through untouched.
  assert.deepStrictEqual(computeAllowedOriginHostnames('app.example.com, moz-extension://*'), [
    'app.example.com',
    'moz-extension://*',
  ]);
});
```

**Verify**: `npm test -- __tests__/http-policy.test.ts` → all pass, 1 more
than before. If any assertion in this test fails, see STOP conditions; do
not edit the expectations.

### Step 2: README row

Replace the description cell of the `FS_ALLOWED_ORIGINS` row
(`README.md:454`) with:

```md
Comma-separated origin hostnames allowed to call `/mcp` from a browser. Replaces the localhost default, so also list `localhost`, `127.0.0.1` or `[::1]` if local browser clients still need access. For browser-extension clients, list the extension ID (the hostname of a `chrome-extension://` origin) or a lowercase `<scheme>://*` entry such as `moz-extension://*` to admit every extension of that scheme; `http://*` and `https://*` are not honoured.
```

Run `npx prettier --write README.md` so the table re-aligns.

**Verify**: `npx prettier --check README.md` → exit 0;
`Select-String -Path README.md -Pattern "moz-extension://\*"` → exactly one hit.

### Step 3: `--help` string

In `src/cli-help.ts:105`, change the `desc` to:

```ts
  {
    flags: 'FS_ALLOWED_ORIGINS',
    desc: 'Comma-separated origin hostnames for CORS; an extension ID or a lowercase <scheme>://* entry (e.g. moz-extension://*) admits browser extensions',
  },
```

Run `npx prettier --write src/cli-help.ts`.

**Verify**: `node src/index.ts --help` → the `FS_ALLOWED_ORIGINS` line
contains `moz-extension://*`; `npm run check:static` → exit 0.

### Step 4: Full check

**Verify**: `npm run check` → exit 0, `fail 0`, ≥ 565 pass (564 + 1).

## Test plan

- `TC-SEC-030b`: wildcard admits its scheme; extension ID admits one
  extension; wrong scheme, uppercase wildcard and `http(s)://*` are refused;
  the env parser passes entries through. Pattern: `TC-SEC-030`
  (`__tests__/http-policy.test.ts:381-399`).
- No end-to-end test is added: `TC-SEC-031b` (`:758-791`) already proves the
  mounted gate and the reflection both run over the same list, and
  `isOriginAllowed` is that same validator.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `npm run check` exits 0; ≥ 565 pass, 0 fail
- [ ] `Select-String -Path README.md,src\cli-help.ts -Pattern "moz-extension://\*"` → exactly two hits, one per file (POSIX: `grep -c 'moz-extension://\*' README.md src/cli-help.ts` → `1` and `1`)
- [ ] `node src/index.ts --help` output contains `moz-extension://*`
- [ ] `git diff --stat -- src/transport src/core` is empty (no runtime change)
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- Any assertion in `TC-SEC-030b` fails. Most likely the installed SDK moved
  (check `node_modules/@modelcontextprotocol/server/package.json` is `2.3.1`
  and the `<scheme>://*` note is at `dist/index.d.mts:331`). If the SDK no
  longer honours the wildcard, the README text would be a lie; report, do
  not document.
- `npm run check:static` fails on `src/cli-help.ts` for a reason other than
  formatting (for example a help-width or line-length test); report the
  failing check rather than shortening the text blind.
- A test elsewhere pins the exact old help string
  `'Comma-separated origin hostnames for CORS'` (search `__tests__/` for it;
  at planning time there were no hits). If one appears, report.

## Maintenance notes

- `TC-SEC-030b` is the alarm for an SDK change to the wildcard rules; when
  bumping `@modelcontextprotocol/server`, a failure there means the README
  row and `--help` need the same edit, not the test.
- Reviewers: check that no normalisation of `FS_ALLOWED_ORIGINS` entries was
  added. The SDK compares the entries as given.
- Deferred: a `--allowed-origins` CLI flag. `FS_ALLOWED_ORIGINS` has no flag
  twin today and this plan does not add one.
