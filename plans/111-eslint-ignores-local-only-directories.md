# Plan 111: ESLint leaves worktrees and other local-only folders alone

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report; do not improvise. When done, update the status row for this plan
> in `plans/README.md`, unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 366c4c96..HEAD -- eslint.config.mjs`
> If the file changed since this plan was written, compare the "Current
> state" excerpt against the live code before proceeding; on a mismatch,
> treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: dx
- **Planned at**: commit `366c4c96`, 2026-11-14

## Why this matters

ESLint's flat config does not read `.gitignore`. The repo's ignore list
names only four folders, so a local `npm run lint` also lints every other
branch checked out under `.worktrees/` (hundreds of files), plus `.scratch/`,
`graphify-out/` and `reports/`. Two costs follow: a stale worktree's lint
error fails the check on a clean `main`, and `npm run fix` (which runs
`eslint . --fix`) silently rewrites files inside other worktrees. CI never
sees this because it has no worktrees.

## Current state

`eslint.config.mjs:18-22`:

```js
export default tseslint.config(
  {
    name: 'project/global-ignores',
    ignores: ['dist/**', 'node_modules/**', '.claude/**', 'examples/**'],
  },
```

Git-ignored or locally excluded folders that hold lintable files:
`.worktrees/` (`.gitignore`), `reports/` (`.gitignore`), `.scratch/`
(`.git/info/exclude`), `graphify-out/`, `coverage/`.

## Commands you will need

| Purpose | Command                                  | Expected on success |
| :------ | :--------------------------------------- | :------------------ |
| Lint    | `npm run lint`                           | exit 0              |
| Format  | `npx prettier --check eslint.config.mjs` | exit 0              |

## Scope

**In scope**:

- `eslint.config.mjs` (the `ignores` array only)
- `plans/README.md`

**Out of scope**:

- Replacing the deprecated `tseslint.config()` helper with `defineConfig`.
- Any rule change.
- `knip.json`, `.prettierignore`, `tsconfig*.json` (those tools already
  honour `.gitignore` or skip dot-folders).

## Git workflow

- Branch: `chore/eslint-ignore-local-dirs`
- One commit: `chore(eslint): ignore worktrees and other local-only folders`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Extend the ignore list

Change the `ignores` line to:

```js
    ignores: [
      'dist/**',
      'node_modules/**',
      '.claude/**',
      'examples/**',
      // Local-only folders: flat config does not read .gitignore, and `eslint . --fix` would rewrite other worktrees.
      '.worktrees/**',
      '.scratch/**',
      'graphify-out/**',
      'reports/**',
      'coverage/**',
    ],
```

**Verify**: `npx prettier --check eslint.config.mjs` → exit 0.

### Step 2: Confirm the folders are ignored

**Verify**: run

```bash
node --input-type=module -e "import {ESLint} from 'eslint'; const e=new ESLint(); for (const p of ['.worktrees/x/src/a.ts','.scratch/a.ts','graphify-out/a.js','reports/a.js','src/index.ts']) console.log(p, await e.isPathIgnored(p));"
```

→ `true` for the first four paths, `false` for `src/index.ts`.

### Step 3: Lint

**Verify**: `npm run lint` → exit 0.

## Test plan

No unit test; Step 2 is the check.

## Done criteria

- [ ] Step 2 prints `true, true, true, true, false`
- [ ] `npm run lint` exits 0
- [ ] `git diff --stat` lists only `eslint.config.mjs` and `plans/README.md`
- [ ] `plans/README.md` status row updated

## STOP conditions

- `npm run lint` fails on files under `src/`, `__tests__/` or `scripts/`
  after the change (it should lint exactly what CI lints).
- The config no longer has a `project/global-ignores` block.

## Maintenance notes

- A new top-level folder that is git-ignored and holds `.ts`/`.js` files
  needs an entry here.
