# Session diagnosis fixes implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the defects and friction found by diagnosing filesystem-mcp's behavior in recorded Claude Code session `748dad2b-1788-4455-945f-f36cfc2971d5`.

**Architecture:** Eight independent fixes, each with its own test cycle and commit. Task 1 changes the shared glob expansion. Tasks 2 to 5 change `read`. Task 6 adds one Scan counter and two `list` notes. Tasks 7 and 8 change `search_text` output and the cursor refusal.

**Tech Stack:** TypeScript on Node's built-in test runner, `@modelcontextprotocol/server`, Zod v4.

**Spec:** No separate file. The findings below are the spec. Each was reproduced against `dist/index.js` at `f7d71333`, except that Claude Code's client-side spill in M2 was only observed in the transcript.

| ID  | Finding                                             | Evidence                | Task |
| :-- | :-------------------------------------------------- | :---------------------- | :--- |
| M1  | `includeHidden` misses dotfiles under `**/name/**`  | L95 → L96               | 1    |
| M2  | Large reads spill where the caller can't reach them | L93 → L94, L151 → L152  | 2    |
| m1  | Complete slices are labelled "truncated"            | L172, L439, 7 others    | 3    |
| m2  | `list` hides what it left out                       | L74 → L75               | 6    |
| m3  | One denial has three shapes                         | L77, L228, L242         | 5    |
| m4  | `read` can't show line numbers                      | L174, L221              | 4    |
| m5  | Single-file searches repeat the path on every row   | L174, 34% of characters | 7    |
| m6  | An expired cursor reads as merely invalid           | Repro only              | 8    |

Out of scope, on purpose:

- **Removing `resource_link` blocks from `read` and `edit` (the other half of m6).** They cost 6,164 characters over 62 calls. They are the subscription handle, and ADR-006 plus about 15 test assertions depend on them. This is a decision for the maintainer, not a defect fix.
- **Clamping a continuation's `endLine` to end of file (part of m1).** The total is unknown without a second pass (`src/tools/read.ts:132`), and reading past the end is valid.
- **Changing the 60-second result-link lifetime.** `src/instructions.ts:71` already documents it.

## Global Constraints

- Work on branch `fix/session-diagnosis-findings`, not `main`.
- Never hand-edit a version in `package.json`, `server.json`, `mcpb/manifest.json`, `.codex-plugin/plugin.json` or `.cursor-plugin/plugin.json`.
- Add user-visible changes to `CHANGELOG.md` under `## [Unreleased]`, creating that section above `## [2.16.0]` if absent.
- When a task changes a tool's schema or description, run `node --test --test-update-snapshots __tests__/contract.test.ts` with no `FS_*` variables set, and commit the `.snapshot` diff with the change.
- Filter tests with `npm test -- --test-name-pattern="<name>"`.
- ADR-005: a sensitive entry leaves no trace, so it is never counted or named.
- End every commit message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

- A dotfile that is sensitive or gitignored under `**/hooks/**` with `includeHidden: true` must stay out of results, even though the pattern now reaches dotfiles (Task 1).
- A slice ending exactly on the file's last line has nothing more to read, so it must carry no trailer at all (Task 3).
- `lineNumbers` on a file with CRLF endings, no trailing newline, or no content must number real lines only and never invent a blank numbered line (Task 4).
- An ignored folder that is sensitive, or that sits below the depth limit, must not be counted or named by `list` (Task 6).
- The second page of a named-file search must keep the same header layout as the first, because a cursor replay never reruns the scan (Task 7).

---

### Task 1: Dot entries under a trailing globstar (M1)

**Files:**

- Modify: `src/core/glob.ts:648-671`
- Modify: `CHANGELOG.md`
- Test: `__tests__/glob.test.ts`, `__tests__/find-files.test.ts`

**Interfaces:**

- Consumes: nothing new.
- Produces: `buildHiddenPatterns` returns more variants. Its signature is unchanged.

- [ ] **Step 1: Write the failing tests**

In `__tests__/glob.test.ts`, using the file's `walk` helper:

```ts
it('a pattern ending in a globstar finds dot entries with includeHidden', async () => {
  const root = await createTestRoot();
  try {
    const files = [
      '.h/hooks/.inner',
      'a/hooks/.d/x.txt',
      'a/hooks/.dot',
      'a/hooks/n.txt',
      'a/hooks/sub/.deep',
    ];
    for (const file of files) {
      await mkdir(dirname(join(root, file)), { recursive: true });
      await writeFile(join(root, file), 'x');
    }
    for (const pattern of ['**/hooks/**', '**/{hooks,lib}/**', '**/hooks/**/*']) {
      assert.deepStrictEqual(
        await walk({ cwd: root, pattern, skipIgnored: true, includeHidden: true }),
        files,
        pattern,
      );
    }
    const wildcard = await walk({
      cwd: root,
      pattern: '*/hooks/**',
      skipIgnored: true,
      includeHidden: true,
    });
    assert.deepStrictEqual(
      wildcard.filter((path) => path.startsWith('a/')),
      files.slice(1),
    );
    assert.deepStrictEqual(
      await walk({ cwd: root, pattern: '**/hooks/**', skipIgnored: true, includeHidden: false }),
      ['a/hooks/n.txt'],
    );
  } finally {
    await cleanupTestRoot(root);
  }
});
```

In `__tests__/find-files.test.ts`:

```ts
it('a trailing globstar keeps sensitive and ignored dotfiles out', async () => {
  await writeTestFile(root, '.gitignore', '*.log\n');
  await writeTestFile(root, 'a/hooks/.env', 'SECRET=1\n');
  await writeTestFile(root, 'a/hooks/.noise.log', 'x');
  await writeTestFile(root, 'a/hooks/.keep', 'x');
  const { structured } = await find({ pattern: '**/hooks/**', includeHidden: true });
  assert.deepStrictEqual(structured.results, [{ path: 'a/hooks/.keep' }]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- --test-name-pattern="trailing globstar|ending in a globstar"`
Expected: FAIL. `**/hooks/**` returns only `a/hooks/n.txt`, and `.keep` is missing.

- [ ] **Step 3: Extend `expandHiddenGlobstars` in `src/core/glob.ts`**

Keep the existing `remainder === '**'` branch. Before the `startsWith('**/')` guard, add the dot complements for any remainder ending in `/**` or `/**/*`. After line 667, add the same complements below a dot ancestor. These expansions were prototyped against `node:fs/promises` `glob` on the Step 1 fixture and returned the expected files:

```ts
const TRAILING_GLOBSTAR = /^(.+\/)\*\*(?:\/\*)?$/u;

const stem = TRAILING_GLOBSTAR.exec(remainder)?.[1];
if (stem) {
  patterns.add(`${prefix}${stem}**/.*`);
  patterns.add(`${prefix}${stem}**/.*/**`);
}
// ...after patterns.add(`${prefix}**/.*/**/${afterGlobstar}`):
if (stem?.startsWith('**/')) {
  patterns.add(`${prefix}**/.*/**/${stem.slice(3)}**/.*`);
  patterns.add(`${prefix}**/.*/**/${stem.slice(3)}**/.*/**`);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- --test-name-pattern="globstar|includeHidden"`
Expected: PASS.

- [ ] **Step 5: Add the changelog line**

Under `### Fixed`: "**`includeHidden` reaches dotfiles under `**/name/**`.** `find_files`, `search_text` and `replace_text` skipped them silently when a wildcard came before a trailing globstar. `replace_text` with such a pattern and `includeHidden: true` now also changes those files."

- [ ] **Step 6: Commit**

```bash
git add src/core/glob.ts __tests__/glob.test.ts __tests__/find-files.test.ts CHANGELOG.md
git commit -m "fix(glob): reach dotfiles under a trailing globstar"
```

### Task 2: Declare `read`'s result size to the client (M2)

**Files:**

- Modify: `src/tools/define.ts:120-152`, `src/tools/define.ts:548-567`
- Modify: `src/tools/read.ts:403-412`
- Modify: `CHANGELOG.md`, `__tests__/contract.test.ts.snapshot`
- Test: `__tests__/tools.test.ts`

**Interfaces:**

- Consumes: nothing new.
- Produces: `ToolDef.listMeta?: Record<string, unknown>`, published as `_meta` in `tools/list`.

> The key and its 500,000 ceiling come from a summarized fetch of the Claude Code MCP docs. Confirm them in the section "Raise the limit for a specific tool" before merging.

- [ ] **Step 1: Write the failing test**

In `__tests__/tools.test.ts`, using `createTestClientPair` as the neighboring tests do:

```ts
it('read alone declares the client result-size hint in tools/list', async () => {
  const harness = await createTestClientPair([tmpDir]);
  try {
    const { tools } = await harness.client.listTools();
    const key = 'anthropic/maxResultSizeChars';
    assert.strictEqual(tools.find((tool) => tool.name === 'read')?._meta?.[key], 200_000);
    for (const tool of tools.filter((candidate) => candidate.name !== 'read')) {
      assert.strictEqual(tool._meta?.[key], undefined, tool.name);
    }
  } finally {
    await harness.close();
  }
});
```

Match the cleanup call the neighboring test at `__tests__/tools.test.ts:252` uses.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- --test-name-pattern="result-size hint"`
Expected: FAIL. `_meta` is undefined.

- [ ] **Step 3: Implement**

Add `readonly listMeta?: Record<string, unknown>` to `ToolDef`. In `toolDefShape`, spread `...(def.listMeta ? { _meta: def.listMeta } : {})`.

On `READ`, set `listMeta: { 'anthropic/maxResultSizeChars': 200_000 }`. Append to its description: `A large result may exceed what the client shows inline: stat gives tokenEstimate, and a slice costs less than a whole file.`

- [ ] **Step 4: Update the snapshot and verify**

Run: `node --test --test-update-snapshots __tests__/contract.test.ts`, then `npm test -- --test-name-pattern="result-size hint|CONTRACT"`
Expected: PASS. The snapshot diff shows only `read`'s `_meta` and description.

- [ ] **Step 5: Add the changelog line**

Under `### Changed`: "**`read` tells the client how large its results can be.** Claude Code keeps results up to 200,000 characters inline instead of saving them to a file outside the roots."

- [ ] **Step 6: Commit**

```bash
git add src/tools/define.ts src/tools/read.ts __tests__/tools.test.ts __tests__/contract.test.ts.snapshot CHANGELOG.md
git commit -m "feat(read): declare the result size to the client"
```

### Task 3: Say "truncated" only when a read was cut (m1)

**Files:**

- Modify: `src/tools/read.ts:289-302`
- Modify: `docs/client-guide.md:342`, `CHANGELOG.md`
- Test: `__tests__/read.test.ts:447-471`, `__tests__/read.test.ts:485-498`, `__tests__/sandbox.test.ts:176`

**Interfaces:**

- Consumes: `PerPathReadValue` fields `head`, `tail`, `startLine`, `endLine`, `linesRead`, `hasMoreLines`.
- Produces: new trailer text. Structured `continuation` is unchanged.

| Read          | More lines remain because | Trailer                                                              |
| :------------ | :------------------------ | :------------------------------------------------------------------- |
| head or range | the requested end was hit | `// more lines from 524. Continue: read {...}`                       |
| head or range | the byte cap stopped it   | `// truncated: More lines remain from 524. ... Continue: read {...}` |
| tail          | requested count returned  | `// more lines above: showing last 10 lines`                         |
| tail          | the byte cap stopped it   | `// truncated: showing last 3 lines`                                 |

- [ ] **Step 1: Update the expectations and add the failing tests**

Change `__tests__/read.test.ts:454` to `/^\/\/ more lines from 11\. Continue: read .*"startLine":11,"endLine":20\}$/m`, `:458` to `indexOf('// more lines')`, and `:469` to `/^\/\/ more lines above: showing last 10 lines$/m`. Change `__tests__/sandbox.test.ts:176` to split on `'\n\n// more lines from'`.

Add to `__tests__/read.test.ts`:

```ts
it('a slice ending on the last line carries no trailer', async () => {
  const file = await writeTestFile(root, 'exact-end.txt', 'a\nb\nc\n');
  for (const args of [{ head: 3 }, { startLine: 2, endLine: 3 }, { startLine: 2, endLine: 99 }]) {
    const result = await read({ path: file, ...args }, { guard });
    assert.ok(!(result.text ?? '').includes('\n// '), JSON.stringify(args));
  }
});
```

In the test at `__tests__/read.test.ts:485`, assert `first.text` matches `/^\/\/ truncated: More lines remain from /m`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- --test-name-pattern="trailer|slice ending|continuation of a range"`
Expected: FAIL on the new trailer text. The exact-end test already passes, and it stays as a guard.

- [ ] **Step 3: Implement in `src/tools/read.ts`**

Add `function wasCut(v: PerPathReadValue): boolean`. The requested count is `v.head ?? v.tail`, or `v.endLine - v.startLine + 1` when both are set. Return true when no count was requested, or when `(v.linesRead ?? 0)` is below it. `readTrailer` picks its row from the table with `wasCut`. Update the doc comment above `readTrailer`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- --test-name-pattern="trailer|slice ending|continuation of a range|sandbox"`
Expected: PASS.

- [ ] **Step 5: Update the docs and changelog**

In `docs/client-guide.md:342`, write: "A partial read ends with a `// more lines ...` line, or `// truncated: ...` when the size limit cut it short, and its". Under `### Fixed` in the changelog: "**`read` no longer calls a complete slice truncated.** `// truncated:` now means the size limit cut the read short."

- [ ] **Step 6: Commit**

```bash
git add src/tools/read.ts __tests__/read.test.ts __tests__/sandbox.test.ts docs/client-guide.md CHANGELOG.md
git commit -m "fix(read): say truncated only when a read was cut"
```

### Task 4: Optional line numbers in `read` (m4)

**Files:**

- Modify: `src/tools/read.ts:66-83`, `src/tools/read.ts:504-511`
- Modify: `docs/client-guide.md:344`, `CHANGELOG.md`, `__tests__/contract.test.ts.snapshot`
- Test: `__tests__/read.test.ts`

**Interfaces:**

- Consumes: the trailer logic from Task 3, which stays outside the numbered text.
- Produces: input `lineNumbers: boolean`, default false.

- [ ] **Step 1: Write the failing tests**

```ts
describe('lineNumbers', () => {
  it('numbers whole files, heads and ranges from their real first line', async () => {
    const file = await writeTestFile(root, 'numbered.txt', 'a\nb\nc\nd\n');
    assert.strictEqual(
      (await read({ path: file, lineNumbers: true }, { guard })).text,
      '1\ta\n2\tb\n3\tc\n4\td\n',
    );
    assert.ok(
      (await read({ path: file, head: 2, lineNumbers: true }, { guard })).text?.startsWith(
        '1\ta\n2\tb\n',
      ),
    );
    assert.ok(
      (
        await read({ path: file, startLine: 3, endLine: 3, lineNumbers: true }, { guard })
      ).text?.startsWith('3\tc'),
    );
  });

  it('adds no blank numbered line and leaves the hash on the file bytes', async () => {
    const crlf = await writeTestFile(root, 'numbered-crlf.txt', 'a\r\nb\r\n');
    assert.strictEqual(
      (await read({ path: crlf, lineNumbers: true }, { guard })).text,
      '1\ta\r\n2\tb\r\n',
    );
    const bare = await writeTestFile(root, 'numbered-bare.txt', 'a\nb');
    assert.strictEqual(
      (await read({ path: bare, lineNumbers: true }, { guard })).text,
      '1\ta\n2\tb',
    );
    const empty = await writeTestFile(root, 'numbered-empty.txt', '');
    assert.strictEqual((await read({ path: empty, lineNumbers: true }, { guard })).text, '');
    const plain = await read({ path: bare, includeHash: true }, { guard });
    const numbered = await read({ path: bare, includeHash: true, lineNumbers: true }, { guard });
    assert.strictEqual(
      valueOf(numbered.structured.results[0])?.contentHash,
      valueOf(plain.structured.results[0])?.contentHash,
    );
  });

  it('is refused with tail', async () => {
    const file = await writeTestFile(root, 'numbered-tail.txt', 'a\n');
    await assert.rejects(
      () => read({ path: file, tail: 1, lineNumbers: true }, { guard }),
      (err) => issuesOf(err).some((issue) => issue.message?.includes("'lineNumbers' with 'tail'")),
    );
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- --test-name-pattern="lineNumbers"`
Expected: FAIL. The strict schema rejects the unknown key.

- [ ] **Step 3: Implement in `src/tools/read.ts`**

Add `lineNumbers: defaultFalseBoolean('Prefix each line with its number and a tab, like cat -n. Leave the prefix out of edit text. Not with tail, which does not count lines.')`. In `superRefine`, refuse it with `tail` using the message `Cannot use 'lineNumbers' with 'tail': a tail read does not count lines.`

Add `numberLines(content: string, firstLine: number): string`. It does not number the empty piece after a final newline, and it returns `''` for empty content. In `body`, apply it before the trailer with `v.startLine ?? 1`, and skip it when `v.mediaData` or `v.blobData` is set.

- [ ] **Step 4: Update the snapshot and verify**

Run: `node --test --test-update-snapshots __tests__/contract.test.ts`, then `npm test -- --test-name-pattern="lineNumbers|CONTRACT"`
Expected: PASS.

- [ ] **Step 5: Update the docs and changelog**

In `docs/client-guide.md:344`, after the `includeHash` sentence, add: "`lineNumbers: true` prefixes each line with its number and a tab." Under `### Added` in the changelog: "**`read` can number its lines.** `lineNumbers: true` works on whole files, `head` and ranges."

- [ ] **Step 6: Commit**

```bash
git add src/tools/read.ts __tests__/read.test.ts __tests__/contract.test.ts.snapshot docs/client-guide.md CHANGELOG.md
git commit -m "feat(read): add optional line numbers"
```

### Task 5: Give `read` errors a code and a next step (m3)

**Files:**

- Modify: `src/core/errors.ts:69`, `src/core/errors.ts:284`
- Modify: `src/tools/read.ts:512-523`
- Modify: `CHANGELOG.md`
- Test: `__tests__/read.test.ts:139`, `__tests__/read.test.ts`

**Interfaces:**

- Consumes: `Problem` from `src/core/errors.ts`.
- Produces: an exported `formatDetailedError(error: Pick<Problem, 'code' | 'message' | 'path' | 'suggestion'>): string`.

- [ ] **Step 1: Update the anchored test and add the failing test**

Change `__tests__/read.test.ts:139` to `/^BINARY_FILE: Binary file detected\. Pass binary: true/`. Add:

```ts
it('names the code and the next step for a refused path', async () => {
  const outside = process.platform === 'win32' ? 'C:\\Windows\\win.ini' : '/etc/hostname';
  const other = process.platform === 'win32' ? 'C:\\Windows\\system.ini' : '/etc/hosts';
  const advice =
    'Use a path under an allowed root; list_roots names them. A path outside them needs a new startup root or an accepted grant.';

  const single = await read({ path: outside }, { guard });
  assert.strictEqual(single.isError, true);
  assert.match(single.text ?? '', /^ACCESS_DENIED: Outside allowed directories\./);
  assert.ok(single.text?.includes(advice));

  const batch = await read({ paths: [outside, other] }, { guard });
  assert.match(batch.text ?? '', /^\/\/ Error: ACCESS_DENIED: Outside allowed directories\./m);
  assert.ok(batch.text?.includes(`// ${advice}`));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- --test-name-pattern="refused path|with binary"`
Expected: FAIL on the missing code prefix.

- [ ] **Step 3: Implement**

Set `DEFAULT_SUGGESTIONS[ErrorCode.ACCESS_DENIED]` to the `advice` string above, and export `formatDetailedError`. In `read.ts`, the single-path error text becomes `formatDetailedError(firstOrdered.error)`. The batch row becomes `// Error: ${code}: ${message}`, followed by `// ${suggestion}` when a suggestion exists. The `// <path>` header already names the path.

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: PASS. Update any other assertion pinned to the old `read` error text or the old suggestion, and no others.

- [ ] **Step 5: Add the changelog line**

Under `### Changed`: "**`read` errors carry their code and next step.** They now match what `stat` and `create` report. `ACCESS_DENIED` says what to do when the path must stay outside the roots."

- [ ] **Step 6: Commit**

```bash
git add src/core/errors.ts src/tools/read.ts __tests__/read.test.ts CHANGELOG.md
git commit -m "fix(read): report the error code and next step"
```

### Task 6: `list` says what it left out (m2)

**Files:**

- Modify: `src/core/glob.ts:445-478`, `src/core/glob.ts:715-811`, `src/core/glob.ts:841-850`
- Modify: `src/core/scan.ts:272-285`, `src/core/scan.ts:492-510`, `src/core/scan.ts:546-554`
- Modify: `src/core/fmt.ts:164-195`
- Modify: `src/tools/list.ts:53-61`, `src/tools/list.ts:101-174`, `src/tools/list.ts:276-297`, `src/tools/list.ts:309-313`, `src/tools/list.ts:390-400`
- Modify: `CHANGELOG.md`, `__tests__/contract.test.ts.snapshot`
- Test: `__tests__/list.test.ts`

**Interfaces:**

- Consumes: `ExcludedDirs` from `src/core/scan.ts`, `formatCount` from `src/core/fmt.ts`.
- Produces:
  - `GlobEntriesOptions.onIgnoredDir?: (posixRelativePath: string) => void`
  - `ScanOutcome.ignoredDirs?: ExcludedDirs`
  - `pageTrailer` input `notes?: readonly string[]`, appended after its other lines
  - `CollectResult` and `ListPageMetadata` fields `unexpandedDirectories: number` and `ignoredDirs?: ExcludedDirs`

- [ ] **Step 1: Write the failing tests**

```ts
it('says how many directories the depth limit left unexpanded', async () => {
  await writeTestFile(root, 'a/b/c.txt', 'x');
  await writeTestFile(root, 'a/top.txt', 'x');
  const { text, structured } = await list({ path: root, maxDepth: 2, includeSizes: true });
  assert.match(
    text ?? '',
    /^\/\/ depth limit 2: contents of 1 directory not listed or counted; raise maxDepth or list one directly\.$/m,
  );
  assert.strictEqual(structured.unexpandedDirectories, 1);
  const flat = await list({ path: root });
  assert.ok(!(flat.text ?? '').includes('depth limit'), 'the default one-level list stays plain');
  const deep = await list({ path: root, maxDepth: 3 });
  assert.ok(!(deep.text ?? '').includes('depth limit'), 'a tree that fits has nothing to report');
});

it('says which ignored folders it hid, and never a sensitive one', async () => {
  await writeTestFile(root, '.gitignore', 'docs/\nvault.key/\n');
  for (const file of [
    'docs/a.md',
    'node_modules/x.js',
    '.git/HEAD',
    'vault.key/inner.txt',
    'src/a.ts',
    'src/node_modules/y.js',
  ]) {
    await writeTestFile(root, file, 'x');
  }
  const noteOf = (text: string | undefined) =>
    (text ?? '').split('\n').find((line) => line.startsWith('// hid ')) ?? '';

  const hidden = await list({ path: root, includeHidden: true });
  const note = noteOf(hidden.text);
  assert.match(
    note,
    /^\/\/ hid 3 ignored folders \(.*\); pass includeIgnored: true to list them\.$/,
  );
  for (const name of ['.git', 'docs', 'node_modules']) assert.ok(note.includes(name), name);
  assert.ok(!(hidden.text ?? '').includes('vault.key'), 'a sensitive folder leaves no trace');
  assert.ok(!note.includes('src/'), 'a folder below the depth limit is not counted');

  const plain = noteOf((await list({ path: root })).text);
  assert.match(plain, /^\/\/ hid 2 ignored folders /);
  assert.ok(!plain.includes('.git'), 'hidden folders are not reported without includeHidden');

  assert.strictEqual(noteOf((await list({ path: root, includeIgnored: true })).text), '');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- --test-name-pattern="depth limit|ignored folders"`
Expected: FAIL. Neither note exists.

- [ ] **Step 3: Implement**

`src/core/glob.ts`: in `prune`'s `excluded` branch, for a directory that `sensitiveDir` and `sensitiveTree` do not hide, and whose depth is at most `maxDepth` when one is set, call `onIgnoredDir(posixRel)` once per path. Compute depth as `posixRel.split('/').length - 1`.

`src/core/scan.ts`: pass `onIgnoredDir` to `globEntries`. Skip a path with a dot-prefixed segment when `options.includeHidden` is false. Count the rest and keep the first 5 shown names in `ignoredDirs`, the way `excludedDirs` does. Do not change `excludedDirs` or `onExcludedDir`.

`src/core/fmt.ts`: add `notes` to `pageTrailer`.

`src/tools/list.ts`:

- In `collect`'s `onEntry`, count a directory whose `relPath.split('/').length === options.maxDepth` as `unexpandedDirectories`.
- Carry `unexpandedDirectories` and `ignoredDirs` through `CollectResult` and `ListPageMetadata`.
- In `run`, pass `notes` with these exact lines. Print the depth line only when `args.maxDepth > DEFAULT_LIST_DEPTH` and the count is above zero:
  - `// depth limit ${maxDepth}: contents of ${formatCount(n, 'directory', 'directories')} not listed or counted; raise maxDepth or list one directly.`
  - `// hid ${formatCount(total, 'ignored folder')} (${names}${more}); pass includeIgnored: true to list ${total === 1 ? 'it' : 'them'}.`
- Add `.git` to the ignored names in the tool description: `(.gitignore matches, .git, node_modules, dist, build, out, tmp)`.

- [ ] **Step 4: Update the snapshot and run the suite**

Run: `node --test --test-update-snapshots __tests__/contract.test.ts`, then `npm test`
Expected: PASS. Scan outcomes pinned with `deepStrictEqual` may need the new optional field. Update only those.

- [ ] **Step 5: Add the changelog line**

Under `### Changed`: "**`list` says what it left out.** A raised `maxDepth` reports how many directories it did not expand, and a walk that skips ignored folders names them."

- [ ] **Step 6: Commit**

```bash
git add src/core/glob.ts src/core/scan.ts src/core/fmt.ts src/tools/list.ts __tests__/list.test.ts __tests__/contract.test.ts.snapshot CHANGELOG.md
git commit -m "feat(list): report unexpanded and ignored folders"
```

### Task 7: Print a named file's path once in `search_text` (m5)

**Files:**

- Modify: `src/tools/search-text.ts:28`, `src/tools/search-text.ts:82-123`, `src/tools/search-text.ts:183-187`, `src/tools/search-text.ts:236-240`, `src/tools/search-text.ts:255`
- Modify: `CHANGELOG.md`, `__tests__/contract.test.ts.snapshot`
- Test: `__tests__/search-text.test.ts:178-188`

**Interfaces:**

- Consumes: `scope.explicitFile` from `resolveScanScope`.
- Produces: `SearchContentPageMetadata.namedFile: boolean`, and `renderRows(matches, withContext: boolean, namedFile: boolean): string[]`. Structured `matches[].file` is unchanged.

- [ ] **Step 1: Update the expectation and add the failing test**

Change `__tests__/search-text.test.ts:188` to `'// explicit_scope/.hidden.log\n1: NEEDLE_SCOPE'`. Add:

```ts
it('prints a named file once, on every page and with context', async () => {
  const file = await writeTestFile(root, 'named/one.txt', 'NEEDLE a\nmid\nNEEDLE b\n');
  const first = await search({ path: file, searchPattern: 'NEEDLE', maxResults: 1, context: 1 });
  assert.ok(first.text?.startsWith('// named/one.txt\n1: NEEDLE a\n2- mid'), first.text);
  const cursor = first.structured.nextCursor;
  assert.ok(cursor);
  const second = await search({
    path: file,
    searchPattern: 'NEEDLE',
    maxResults: 1,
    context: 1,
    cursor,
  });
  assert.ok(second.text?.startsWith('// named/one.txt\n2- mid\n3: NEEDLE b'), second.text);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- --test-name-pattern="named file|explicit"`
Expected: FAIL. Rows still carry the path.

- [ ] **Step 3: Implement**

In `produce`, set `namedFile: scope.explicitFile !== undefined` in the metadata, so a cursor replay finds it. In `renderRows`, when `namedFile` is true and there are rows, put `// ${file}` first and render rows as `${line}: ${content}`, with context rows as `${n}- ${text}`. Directory searches stay byte-identical. Append to the tool description: `A named file prints its path once, as a header.`

- [ ] **Step 4: Update the snapshot and run the suite**

Run: `node --test --test-update-snapshots __tests__/contract.test.ts`, then `npm test`
Expected: PASS. Update other assertions that search a named file and pin the old row, and no others.

- [ ] **Step 5: Add the changelog line**

Under `### Changed`: "**`search_text` prints a named file's path once.** Rows from a single-file search no longer repeat it. Directory searches and `_meta` are unchanged."

- [ ] **Step 6: Commit**

```bash
git add src/tools/search-text.ts __tests__/search-text.test.ts __tests__/contract.test.ts.snapshot CHANGELOG.md
git commit -m "feat(search_text): print a named file's path once"
```

### Task 8: Say a cursor may have expired (m6)

**Files:**

- Modify: `src/core/store.ts:275-280`
- Modify: `CHANGELOG.md`
- Test: `__tests__/page-store.test.ts`

**Interfaces:**

- Consumes: `ENTRY_TTL_MS` in `src/core/store.ts`.
- Produces: new refusal text that still contains `Invalid cursor`, so existing matchers hold.

- [ ] **Step 1: Write the failing test**

```ts
it('a refused cursor names both ways it goes stale and the remedy', () => {
  assert.strictEqual(
    invalidCursor().message,
    'Invalid cursor: a page expires after 60 seconds, and a cursor works only with the query that made it. Request the first page without a cursor.',
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- --test-name-pattern="refused cursor"`
Expected: FAIL on the old text.

- [ ] **Step 3: Update `invalidCursor` in `src/core/store.ts`**

Build the seconds from `ENTRY_TTL_MS / 1000`.

- [ ] **Step 4: Run the cursor tests**

Run: `npm test -- --test-name-pattern="cursor"`
Expected: PASS.

- [ ] **Step 5: Add the changelog line**

Under `### Changed`: "**A refused cursor says why it may have gone stale.**"

- [ ] **Step 6: Run the final checks**

Run: `npm run check`, then `graphify update .`, then `git status --short`
Expected: `npm run check` exits 0, and only this task's files are uncommitted.

- [ ] **Step 7: Commit**

```bash
git add src/core/store.ts __tests__/page-store.test.ts CHANGELOG.md
git commit -m "fix(cursor): say why a cursor may have gone stale"
```
