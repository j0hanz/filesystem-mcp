# Plan 031: The default denylist covers modern SSH keys and the common credential stores

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 8c2a82cd..HEAD -- src/core/sensitive.ts src/instructions.ts __tests__/security.test.ts`
> If `sensitive.ts:237-253` changed, compare against the excerpt before
> proceeding; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW (a pattern that over-matches can be lifted per file with `--allow`)
- **Depends on**: none — run **before** plan 038 (docs wording)
- **Category**: security
- **Planned at**: commit `8c2a82cd`, 2026-09-26

## Why this matters

The built-in denylist protects `*id_rsa*` and `*id_dsa*`. OpenSSH has
generated `id_ed25519` by default for years; `id_ecdsa` and the FIDO
`id_ed25519_sk` variants are also common. All of them are readable today.
The desktop bundle promises otherwise: `mcpb/manifest.json:7` says "sensitive
files such as `.env`, `*.pem`, and SSH keys are denied by default".

Other credential stores that live in a checkout or home directory and are
never something a coding assistant needs to read: `.netrc` / `_netrc`,
`.git-credentials`, `.pgpass`, `.docker/config.json`, `.kube/config`, gcloud's
`application_default_credentials.json`. Probed during the audit: every one is
allowed.

## Current state

```ts
// src/core/sensitive.ts:237-253
const DEFAULT_SENSITIVE_PATTERNS = [
  '.env',
  '.env.*',
  '.npmrc',
  '.pypirc',
  '.aws/credentials',
  '.aws/config',
  '.mcpregistry_*_token',
  '*.pem',
  '*.key',
  '*.p12',
  '*.pfx',
  '*.crt',
  '*.cer',
  '*id_rsa*',
  '*id_dsa*',
] as const;
```

Pattern semantics (`sensitive.ts:27-34`): `*` matches within a segment, `**`
whole segments, a pattern with `/` matches against the full normalized path,
one without matches the basename; matching is case-insensitive
(`normalizeForMatch`, line 14–20). `FS_ALLOW_SENSITIVE` disables the whole
built-in tier; `--allow` / `FS_ALLOWLIST` lifts single built-in hits
(`buildDenyTiers`, lines 299–312).

`src/instructions.ts:68`:
`'sensitive_paths: Sensitive file paths (.env, *.pem, *id_rsa*) are denied by default.',`
— `__tests__/resources.test.ts:73` only asserts the `sensitive_paths:`
prefix.

Existing matcher tests: `__tests__/security.test.ts` around line 363 builds
`new SensitiveMatcher()` (defaults) and asserts
`matcher.isSensitive('.id_rsa') === true` with the message
`'*id_rsa* must match .id_rsa'`.

## Commands you will need

| Purpose        | Command                                                                                     | Expected on success |
| -------------- | ------------------------------------------------------------------------------------------- | ------------------- |
| Static check   | `npm run check:static`                                                                      | exit 0              |
| All tests      | `npm test`                                                                                  | all pass            |
| Filter by name | `npm test -- --test-name-pattern="modern SSH keys"`                                         | passes              |
| Format         | `npx prettier --write src/core/sensitive.ts src/instructions.ts __tests__/security.test.ts` | exit 0              |

## Scope

**In scope** (the only files you should modify):

- `src/core/sensitive.ts` — the `DEFAULT_SENSITIVE_PATTERNS` array only
- `src/instructions.ts` — line 68 wording
- `__tests__/security.test.ts` — one new test
- `plans/README.md` (status row)

**Out of scope**: `README.md` (plan 038 updates docs; its "and similar
patterns" wording stays true); `mcpb/manifest.json` (its claim becomes true
with no edit); the matcher engine; operator tiers.

## Git workflow

- Branch: `advisor/031-denylist-modern-keys`.
- One commit: `fix(sensitive): deny modern SSH keys and common credential stores by default`.
- End each commit message with the attribution line the operator's
  environment requires, if any.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Regression test (it must fail now)

In `__tests__/security.test.ts`, inside the `describe` that already contains
the `'*id_rsa* must match .id_rsa'` assertion (around line 363), add a new
`it`:

```ts
it('the default denylist covers modern SSH keys and common credential stores', () => {
  const matcher = new SensitiveMatcher();
  const denied = [
    'id_ed25519',
    '.ssh/id_ed25519',
    'id_ed25519_sk',
    'id_ecdsa',
    'ID_ECDSA.bak',
    '.netrc',
    '_netrc',
    '.git-credentials',
    '.pgpass',
    '.docker/config.json',
    '.kube/config',
    'gcloud/application_default_credentials.json',
  ];
  for (const name of denied) {
    assert.strictEqual(matcher.isSensitive(name), true, `${name} must be denied`);
  }
  // `*id_ed25519*` also catches `id_ed25519.pub`, exactly as `*id_rsa*`
  // catches `id_rsa.pub` today — an accepted over-match, so no `.pub`
  // or `.md` sibling is asserted readable here.
  const allowed = ['docker/config.json', 'kube/config', 'netrc.txt', 'README.md'];
  for (const name of allowed) {
    assert.strictEqual(matcher.isSensitive(name), false, `${name} must stay readable`);
  }
});
```

**Verify**: `npm test -- --test-name-pattern="modern SSH keys"` → **fails**
at `id_ed25519 must be denied`. If it passes, STOP.

### Step 2: Extend the built-in tier

In `src/core/sensitive.ts`, replace the array (lines 237–253) with:

```ts
const DEFAULT_SENSITIVE_PATTERNS = [
  '.env',
  '.env.*',
  '.npmrc',
  '.pypirc',
  '.netrc',
  '_netrc',
  '.git-credentials',
  '.pgpass',
  '.aws/credentials',
  '.aws/config',
  '.docker/config.json',
  '.kube/config',
  'application_default_credentials.json',
  '.mcpregistry_*_token',
  '*.pem',
  '*.key',
  '*.p12',
  '*.pfx',
  '*.crt',
  '*.cer',
  '*id_rsa*',
  '*id_dsa*',
  '*id_ecdsa*',
  '*id_ed25519*',
] as const;
```

### Step 3: Instructions wording

In `src/instructions.ts:68`, change the parenthetical to
`(.env, *.pem, SSH private keys such as *id_rsa* and *id_ed25519*, .netrc, .git-credentials)`.
Keep the `sensitive_paths:` prefix and the trailing `are denied by default.`.

Run `npx prettier --write src/core/sensitive.ts src/instructions.ts __tests__/security.test.ts`.

**Verify**: `npm test -- --test-name-pattern="modern SSH keys"` → passes;
`node --test __tests__/security.test.ts __tests__/resources.test.ts __tests__/prompts.test.ts`
→ all pass.

### Step 4: Full gate

**Verify**: `npm run check` → exit 0.

## Test plan

- New test: twelve denied names (SSH key variants in several spellings and
  paths, the credential stores) and four names that must stay readable.
- Existing: `TC-SEC-008/009/010`, every `SensitiveMatcher` test, the
  instructions/prompt tests that check section prefixes.

## Done criteria

ALL must hold:

- [ ] `npm run check` exits 0
- [ ] `grep -c "id_ed25519\|id_ecdsa\|\.netrc\|\.git-credentials\|\.pgpass\|\.kube/config\|\.docker/config.json\|application_default_credentials" src/core/sensitive.ts` prints `8`
- [ ] `grep -n "id_ed25519" src/instructions.ts` prints one line
- [ ] The new test exists and passes
- [ ] `git status` shows changes only in the in-scope files
- [ ] `plans/README.md` status row for 031 updated

## STOP conditions

Stop and report back (do not improvise) if:

- The regression test passes before Step 2.
- One of the four `allowed` names is denied after Step 2 (a pattern is wider
  than intended) — report which, do not weaken the pattern silently.
- Any existing fixture file in `__tests__` is named like a new pattern and a
  previously passing test now gets `ACCESS_DENIED` — report the test name.
- A step's verification fails twice after a reasonable fix attempt.

## Maintenance notes

- An operator whose repo legitimately contains e.g. a `.kube/config` template
  lifts it with `--allow .kube/config` or `FS_ALLOWLIST`; document that in the
  README when plan 038 runs if a user asks.
- `*id_ed25519*` and `*id_ecdsa*` also deny the `.pub` halves, as `*id_rsa*`
  already does. Narrowing to private keys only would need a negative
  pattern the matcher does not support; not worth adding for public keys.
