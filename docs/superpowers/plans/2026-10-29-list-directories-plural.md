# Fix the `list` totals line plural implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `list` with `includeSizes: true` prints `N directories` instead of `N directorys` when it counts more than one directory, or none.

**Architecture:** `summaryLine` (`src/tools/list.ts:239-244`) calls `formatCount(metadata.totalDirectories, 'directory')`. `formatCount` (`src/core/fmt.ts:54`) builds the default plural by appending `s`. Pass the irregular plural explicitly, the same way `fmt.ts:155` and `search-text.ts:126` already do. The existing test (`__tests__/tools.test.ts:2377`) uses exactly one directory, which is why it never caught this.

**Tech Stack:** TypeScript, Node built-in test runner.

**Spec:** The 2026-10-29 analysis of the telltale log `C:\j0hanz-marketplace\.claude\telltale\76dcc3f6-2ecb-485c-bffe-21c803f3a62d\turn-1.jsonl:2`. The output was `// 25 files, 4 directorys, 78 KiB total`. It was reproduced against `dist/index.js` as `// 58 files, 3 directorys, 707 KiB total`.

## Global Constraints

- Change only the plural argument. The line format stays `// <files>, <directories>, <bytes> total`.
- Do not hand-edit any version field (`package.json`, `server.json`, `mcpb/manifest.json`, `.codex-plugin/plugin.json`, `.cursor-plugin/plugin.json`).
- `npm run check` passes before the commit.
- Commits end with the two attribution trailer lines from the session reminder.

## Out of scope (decided 2026-10-29)

These are the other two findings from the analysis. Both are deliberately left out.

- **`// truncated:` wording on ranged reads** (`src/tools/read.ts:290`). The marker is a documented client contract (`docs/client-guide.md:338`). Two tests also pin it: `__tests__/tools.test.ts:2060` and `__tests__/sandbox.test.ts:173`. Renaming it would break clients that look for it, and the gain is only cosmetic.
- **Lowercased drive letter in `create` output** (`src/core/path-utils.ts:164`). This normalization feeds `PathGuard` comparisons, so a change there carries security risk for a cosmetic gain.

## Review Focus

- **Zero directories:** a flat directory with only files must print `0 directories`. `formatCount` uses the plural for every count except 1. Task 1 tests this.
- **Exactly one directory:** the line must keep printing `1 directory`. The existing assertion at `tools.test.ts:2393` already pins this. Task 1 leaves that assertion unchanged.
- **Files plural:** `1 file` against `N files` already works (the default `s`). No new test is needed.

---

### Task 1: Pass `'directories'` to the totals line

**Files:**

- Modify: `src/tools/list.ts:240-243`
- Test: `__tests__/tools.test.ts` (new `it` after the one at line 2377)

**Interfaces:**

- Consumes: `formatCount(count: number, singular: string, plural?: string): string` from `src/core/fmt.ts:54`. It already exists; do not change it.
- Produces: nothing new.

- [ ] **Step 1: Write the failing test**

Add this after `list includeSizes shows sizes and a totals line (#99)`. It uses the same `harness`, `tmpDir` and `firstTextBlock` helpers as that test.

```ts
it('list includeSizes pluralizes directories in the totals line', async () => {
  const many = join(tmpDir, 'sizes_many_dirs');
  await mkdir(join(many, 'd1'), { recursive: true });
  await mkdir(join(many, 'd2'), { recursive: true });
  await writeFile(join(many, 'a.txt'), '12345');
  const manyText =
    firstTextBlock(
      await harness.client.callTool({
        name: 'list',
        arguments: { path: many, includeSizes: true },
      }),
    ).text ?? '';
  assert.match(manyText, /^\/\/ 1 file, 2 directories, 5 B total$/m);

  const flat = join(tmpDir, 'sizes_no_dirs');
  await mkdir(flat, { recursive: true });
  await writeFile(join(flat, 'a.txt'), '12345');
  const flatText =
    firstTextBlock(
      await harness.client.callTool({
        name: 'list',
        arguments: { path: flat, includeSizes: true },
      }),
    ).text ?? '';
  assert.match(flatText, /^\/\/ 1 file, 0 directories, 5 B total$/m);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- --test-name-pattern="pluralizes directories"`
Expected: FAIL, with the received text containing `2 directorys`.

- [ ] **Step 3: Pass the plural in `summaryLine` (`src/tools/list.ts`)**

Add `'directories'` as the third argument to the `formatCount(metadata.totalDirectories, 'directory')` call. Change nothing else.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- --test-name-pattern="includeSizes"`
Expected: PASS for all `list includeSizes …` tests, including the existing `1 directory` assertion.

- [ ] **Step 5: Run the full check**

Run: `npm run check`
Expected: exit 0. The `contract.test.ts` snapshot must be unchanged, because the totals line is not part of the advertised surface.

- [ ] **Step 6: Commit**

```bash
git add src/tools/list.ts __tests__/tools.test.ts
git commit -m "fix(list): pluralize directories in the includeSizes totals line"
```
