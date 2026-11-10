import assert from 'node:assert/strict';
import { readFile, utimes, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import type * as z from 'zod/v4';

import { GuardedFileSystem } from '../src/core/fs.ts';
import { EDIT, findFrom, type FlexMatch, flexMatches } from '../src/tools/edit.ts';
import {
  cleanupTestRoot,
  createTestClientPair,
  createTestRoot,
  makeGuard,
  trySymlink,
  writeTestFile,
} from './helpers.ts';
import { runToolBodyResult, schemaIssues, type ToolBodyOptions } from './tool-harness.ts';

type EditArgs = z.input<typeof EDIT.def.input>;
type EditRun = Awaited<ReturnType<typeof runToolBodyResult<typeof EDIT.def.input, object>>> & {
  readonly structured: EditStructured;
};
interface EditStructured {
  readonly results: readonly {
    readonly path: string;
    readonly value?: { modified?: string; size?: number; resourceUri?: string };
    readonly error?: { code: string; message: string };
  }[];
  readonly summary: { total: number; succeeded: number; failed: number };
}

const firstError = (result: EditRun) => result.structured.results[0]?.error;

describe('edit body', () => {
  let root: string;
  let fs: GuardedFileSystem;

  beforeEach(async () => {
    root = await createTestRoot();
    fs = new GuardedFileSystem(await makeGuard([root]));
  });

  afterEach(async () => {
    await cleanupTestRoot(root);
  });

  const edit = async (args: EditArgs, options: Partial<ToolBodyOptions> = {}): Promise<EditRun> =>
    (await runToolBodyResult(EDIT, args, { fs, ...options })) as EditRun;

  it('applies an edit in single-path and batch form', async () => {
    const file = join(root, 'edit.txt');
    const edits = [{ oldText: 'original', newText: 'modified' }];
    for (const args of [{ path: file, edits }, { files: [{ path: file, edits }] }]) {
      await writeFile(file, 'original content');
      const result = await edit(args);
      assert.notStrictEqual(result.isError, true);
      assert.strictEqual(await readFile(file, 'utf-8'), 'modified content');
    }
  });

  it('names each failed path, code and reason in a partial batch', async () => {
    const good = await writeTestFile(root, 'edit-partial-ok.txt', 'original');
    const missing = join(root, 'edit-partial-missing.txt');
    const edits = [{ oldText: 'original', newText: 'modified' }];
    const result = await edit({
      files: [
        { path: good, edits },
        { path: missing, edits },
      ],
    });

    const error = result.structured.results[1]?.error;
    assert.ok(error);
    const [head, reason, ...rest] = (result.text ?? '').split('\n');
    assert.match(head ?? '', /FAILED \(1\/2 ok\)$/);
    assert.strictEqual(reason, `// ${missing}: ${error.code} ${error.message}`);
    assert.deepStrictEqual(rest, []);
  });

  it('refuses an empty or blank oldText with one message', async () => {
    const file = await writeTestFile(root, 'edit-blank-old.txt', 'original content');
    for (const oldText of ['', '   ']) {
      assert.deepStrictEqual(
        await schemaIssues(edit({ path: file, edits: [{ oldText, newText: 'x' }] })),
        ['oldText cannot be empty or whitespace-only'],
        JSON.stringify(oldText),
      );
    }
    assert.strictEqual(await readFile(file, 'utf-8'), 'original content');
  });

  it('refuses a batch that names the same file twice', async () => {
    const original = 'alpha\nbeta\n';
    const file = await writeTestFile(root, 'dup-batch/dup.txt', original);
    const caseless = process.platform === 'win32' || process.platform === 'darwin';
    for (const twin of caseless ? [file, join(dirname(file), 'DUP.TXT')] : [file]) {
      const issues = await schemaIssues(
        edit({
          files: [
            { path: file, edits: [{ oldText: 'alpha', newText: 'A' }] },
            { path: twin, edits: [{ oldText: 'beta', newText: 'B' }] },
          ],
        }),
      );
      assert.ok(
        issues.some((m) => m.startsWith('duplicate of files[0].path')),
        issues.join('; '),
      );
    }
    assert.strictEqual(await readFile(file, 'utf-8'), original);
  });

  it('refuses path with edits and files in one call', async () => {
    const f = await writeTestFile(root, 'edit_both_forms.txt', 'one\n');
    const spec = [{ oldText: 'one', newText: 'two' }];
    const issues = await schemaIssues(
      edit({ path: f, edits: spec, files: [{ path: f, edits: spec }] }),
    );
    assert.ok(issues.includes("Provide exactly one of 'path' or 'files'"), issues.join('; '));
    assert.strictEqual(await readFile(f, 'utf-8'), 'one\n');
  });

  it('reports a change it could not diff instead of "(no change)"', async () => {
    const lines = (prefix: string, n: number): string =>
      Array.from({ length: n }, (_, i) => `${prefix}${String(i)}`).join('\n') + '\n';
    const before = lines('a', 20000);
    const after = lines('b', 20000);
    // A whole-file rewrite outruns DIFF_TIMEOUT_MS: the edit still applies, so the
    // summary must not claim "(no change)".
    const file = await writeTestFile(root, 'edit-diff-timeout.txt', before);
    const edits = [{ oldText: before, newText: after }];

    const preview = await edit({ path: file, edits, dryRun: true });
    assert.notStrictEqual(preview.isError, true);
    assert.strictEqual(
      preview.text,
      'edit: edit-diff-timeout.txt changed (too many lines to diff) [dry run]',
    );
    assert.strictEqual(await readFile(file, 'utf-8'), before);

    const applied = await edit({ path: file, edits });
    assert.notStrictEqual(applied.isError, true);
    assert.strictEqual(
      applied.text,
      'edit: edit-diff-timeout.txt changed (too many lines to diff)',
    );
    assert.strictEqual(await readFile(file, 'utf-8'), after);

    // An identical replacement is still a true no-op in the summary.
    const same = await edit({ path: file, edits: [{ oldText: 'b0\n', newText: 'b0\n' }] });
    assert.notStrictEqual(same.isError, true);
    assert.match(same.text ?? '', /^edit: edit-diff-timeout\.txt \(no change\)/u);
  });

  // An oldText that occurs more than once used to edit the first occurrence and
  // report success, so the wrong block changed silently.
  it('rejects an oldText that matches more than once, dry run included', async () => {
    const original = 'a\nfoo\nb\nfoo\nc\nfoo\n';
    const file = await writeTestFile(root, 'ambiguous/literal.txt', original);

    for (const dryRun of [false, true]) {
      const result = await edit({
        path: file,
        edits: [{ oldText: 'foo', newText: 'bar' }],
        dryRun,
      });
      assert.strictEqual(result.isError, true, `dryRun=${String(dryRun)}`);
      const error = firstError(result);
      assert.strictEqual(error?.code, 'INVALID_INPUT');
      assert.match(error?.message ?? '', /3 places \(lines 2, 4, 6\)/u);
      assert.strictEqual(await readFile(file, 'utf-8'), original);
    }
  });

  it('counts overlapping occurrences of oldText as ambiguous', async () => {
    const file = await writeTestFile(root, 'ambiguous/overlap.txt', 'ababab\n');
    for (const ignoreWhitespace of [false, true]) {
      const result = await edit({
        path: file,
        edits: [{ oldText: 'abab', newText: 'X' }],
        ignoreWhitespace,
      });
      assert.strictEqual(result.isError, true, `ignoreWhitespace=${String(ignoreWhitespace)}`);
      assert.match(firstError(result)?.message ?? '', /2 places \(line 1\)/u);
      assert.strictEqual(await readFile(file, 'utf-8'), 'ababab\n');
    }
  });

  // Leading whitespace in the flexible pattern matches from any column of the
  // indentation, which is the same occurrence, not a second one.
  it('with ignoreWhitespace applies a unique indented oldText', async () => {
    const file = await writeTestFile(root, 'ambiguous/indented.txt', 'f() {\n    run();\n}\n');
    const result = await edit({
      path: file,
      edits: [{ oldText: '  run();', newText: '  go();' }],
      ignoreWhitespace: true,
    });
    assert.notStrictEqual(result.isError, true);
    assert.strictEqual(await readFile(file, 'utf-8'), 'f() {\n    go();\n}\n');
  });

  it('with ignoreWhitespace keeps the blank line and indentation after a trailing newline', async () => {
    const file = await writeTestFile(
      root,
      'ambiguous/trailing-edge.py',
      'def f():\n    x = 1\n\n    y = 2\n',
    );
    const result = await edit({
      path: file,
      edits: [{ oldText: '    x = 1\n', newText: '    x = 3\n' }],
      ignoreWhitespace: true,
    });
    assert.notStrictEqual(result.isError, true);
    assert.strictEqual(await readFile(file, 'utf-8'), 'def f():\n    x = 3\n\n    y = 2\n');
  });

  it('with ignoreWhitespace keeps the blank lines before a leading newline', async () => {
    const file = await writeTestFile(root, 'ambiguous/leading-edge.txt', 'a\n\n\n    y = 2\n');
    const result = await edit({
      path: file,
      edits: [{ oldText: '\n    y = 2', newText: '\n    y = 3' }],
      ignoreWhitespace: true,
    });
    assert.notStrictEqual(result.isError, true);
    assert.strictEqual(await readFile(file, 'utf-8'), 'a\n\n\n    y = 3\n');
  });

  // The flexible match absorbs the file's indentation, so newText written at
  // oldText's indentation must be mapped back onto the file's own.
  it('with ignoreWhitespace re-indents newText to the matched lines', async () => {
    const spaces = await writeTestFile(
      root,
      'reindent/spaces.js',
      'function f() {\n    if (x) {\n        y();\n    }\n}\n',
    );
    const spaced = await edit({
      path: spaces,
      edits: [{ oldText: 'if (x) {\n  y();\n}', newText: 'if (x) {\n  z();\n}' }],
      ignoreWhitespace: true,
    });
    assert.notStrictEqual(spaced.isError, true);
    assert.strictEqual(
      await readFile(spaces, 'utf-8'),
      'function f() {\n    if (x) {\n        z();\n    }\n}\n',
    );

    // The file's tabs are reused literally, and an inserted line takes the
    // indentation of the oldText line it is indented like.
    const tabs = await writeTestFile(root, 'reindent/tabs.js', '\tif (x) {\n\t\ty();\n\t}\n');
    const tabbed = await edit({
      path: tabs,
      edits: [{ oldText: 'if (x) {\n  y();\n}', newText: 'if (x) {\n  z();\n  w();\n}' }],
      ignoreWhitespace: true,
    });
    assert.notStrictEqual(tabbed.isError, true);
    assert.strictEqual(await readFile(tabs, 'utf-8'), '\tif (x) {\n\t\tz();\n\t\tw();\n\t}\n');
  });

  // A timing guard, not a regression catcher: the old quadratic code was also fast at 2000 lines.
  it('with ignoreWhitespace re-indents a 2000-line block well inside the deadline', async () => {
    const body = Array.from({ length: 2_000 }, (_, i) => `    v${String(i)} = ${String(i)};`);
    const file = await writeTestFile(root, 'reindent/huge.js', `${body.join('\n')}\n`);
    const withExtra = [body[0], '    extra();', ...body.slice(1)];
    const started = Date.now();
    const result = await edit({
      path: file,
      edits: [{ oldText: body.join('\n'), newText: withExtra.join('\n') }],
      ignoreWhitespace: true,
    });
    const elapsed = Date.now() - started;
    assert.notStrictEqual(result.isError, true, result.text);
    assert.ok(elapsed < 2000, `took ${String(elapsed)} ms`);
    assert.strictEqual(await readFile(file, 'utf-8'), `${withExtra.join('\n')}\n`);
  });

  it('with ignoreWhitespace applies a 5,000-line oldText (#157)', async () => {
    const body = `${Array.from({ length: 5_000 }, (_, i) => `    v${String(i)} = ${String(i)};`).join('\n')}\n`;
    const file = await writeTestFile(root, 'flex/big-old.js', body);
    const result = await edit({
      path: file,
      edits: [{ oldText: body.replaceAll('    ', '  '), newText: 'done();\n' }],
      ignoreWhitespace: true,
    });
    assert.notStrictEqual(result.isError, true, result.text);
    assert.strictEqual(await readFile(file, 'utf-8'), 'done();\n');
  });

  it('with ignoreWhitespace edits a 9 MB file (#157)', async () => {
    const filler = '    filler_line_with_some_text = 12345;\n';
    const file = await writeTestFile(
      root,
      'flex/big-file.txt',
      `${filler.repeat(240_000)}    unique_marker();\n`,
    );
    const result = await edit({
      path: file,
      edits: [{ oldText: 'unique_marker();', newText: 'done();' }],
      ignoreWhitespace: true,
    });
    assert.notStrictEqual(result.isError, true, result.text);
    assert.ok((await readFile(file, 'utf-8')).endsWith('    done();\n'));
  });

  it('with ignoreWhitespace stays fast on repetitive near-matches', async () => {
    // Sized for the coverage run, which slows the walk about eightfold.
    const file = await writeTestFile(root, 'flex/repetitive.txt', 'a\n'.repeat(20_000));
    const started = Date.now();
    const result = await edit({
      path: file,
      // Every line is a candidate walked 100 lines deep before it fails:
      // the walk is candidates × oldText, so this catches a walk that grows
      // with the file per candidate.
      edits: [{ oldText: `${'a\n'.repeat(100)}b`, newText: 'x' }],
      ignoreWhitespace: true,
      dryRun: true,
    });
    const elapsed = Date.now() - started;
    // A dry run reports an unmatched edit without failing.
    assert.notStrictEqual(result.isError, true, result.text);
    assert.ok(elapsed < 2000, `took ${String(elapsed)} ms`);
  });

  it('with ignoreWhitespace matches an NBSP oldText against the same NBSP', async () => {
    const file = await writeTestFile(root, 'flex/nbsp.txt', 'a\u00a0b\n');
    const result = await edit({
      path: file,
      edits: [{ oldText: 'a\u00a0b', newText: 'ok' }],
      ignoreWhitespace: true,
    });
    assert.notStrictEqual(result.isError, true, result.text);
    assert.strictEqual(await readFile(file, 'utf-8'), 'ok\n');
  });

  it('rejects an oldText holding an unpaired surrogate', async () => {
    for (const half of ['\ud83d', '\ude00']) {
      for (const ignoreWhitespace of [false, true]) {
        const file = await writeTestFile(root, 'flex/surrogate.txt', '😀\n');
        const result = await edit({
          path: file,
          edits: [{ oldText: half, newText: 'X' }],
          ignoreWhitespace,
        });
        const label = `${JSON.stringify(half)} ignoreWhitespace=${String(ignoreWhitespace)}`;
        assert.strictEqual(result.isError, true, label);
        assert.match(firstError(result)?.message ?? '', /unpaired surrogate/u, label);
        assert.strictEqual(await readFile(file, 'utf-8'), '😀\n', label);
      }
    }
  });

  it('with ignoreWhitespace keeps a file-leading BOM out of the indentation', async () => {
    const file = await writeTestFile(root, 'flex/bom.py', '\ufeff# header\npass\n');
    const result = await edit({
      path: file,
      edits: [{ oldText: ' # header\npass', newText: ' # header\n # inserted\npass' }],
      ignoreWhitespace: true,
    });
    assert.notStrictEqual(result.isError, true, result.text);
    assert.strictEqual(await readFile(file, 'utf-8'), '\ufeff# header\n# inserted\npass\n');
  });

  it('with ignoreWhitespace keeps the file indentation of a flattened oldText in a CRLF file', async () => {
    const file = await writeTestFile(
      root,
      'reindent/crlf.js',
      'function f() {\r\n    if (x) {\r\n        y();\r\n    }\r\n}\r\n',
    );
    const result = await edit({
      path: file,
      edits: [{ oldText: 'y();\n}', newText: 'w();\n}' }],
      ignoreWhitespace: true,
    });
    assert.notStrictEqual(result.isError, true);
    assert.strictEqual(
      await readFile(file, 'utf-8'),
      'function f() {\r\n    if (x) {\r\n        w();\r\n    }\r\n}\r\n',
    );
  });

  it('names the ambiguous edit and flags lines shifted by earlier edits', async () => {
    const original = 'x\nfoo\nfoo\n';
    const file = await writeTestFile(root, 'ambiguous/index.txt', original);

    const shifted = await edit({
      path: file,
      edits: [
        { oldText: 'x\n', newText: 'y\nz\n' },
        { oldText: 'foo', newText: 'bar' },
      ],
    });
    assert.match(
      firstError(shifted)?.message ?? '',
      /^edits\[1\]: oldText matches 2 places after earlier edits \(lines 3, 4\)/u,
    );

    // An earlier edit that matched nothing changed nothing, so the lines are the file's own.
    const unshifted = await edit({
      path: file,
      edits: [
        { oldText: 'missing', newText: 'y' },
        { oldText: 'foo', newText: 'bar' },
      ],
    });
    assert.match(
      firstError(unshifted)?.message ?? '',
      /^edits\[1\]: oldText matches 2 places \(lines 2, 3\)/u,
    );
    assert.strictEqual(await readFile(file, 'utf-8'), original);
  });

  it('lists at most five matched lines', async () => {
    const file = await writeTestFile(root, 'ambiguous/many.txt', 'foo\n'.repeat(6));
    const result = await edit({ path: file, edits: [{ oldText: 'foo', newText: 'bar' }] });
    assert.match(firstError(result)?.message ?? '', /6 places \(lines 1, 2, 3, 4, 5, \.\.\.\)/u);
  });

  it('with ignoreWhitespace rejects an oldText that matches more than once', async () => {
    const original = 'if (x) {\n  run();\n}\nif (x) {\n    run();\n}\n';
    const file = await writeTestFile(root, 'ambiguous/whitespace.txt', original);
    const result = await edit({
      path: file,
      edits: [{ oldText: 'if (x) {\nrun();', newText: 'if (y) {\nrun();' }],
      ignoreWhitespace: true,
    });
    assert.strictEqual(result.isError, true);
    assert.match(firstError(result)?.message ?? '', /2 places \(lines 1, 4\)/u);
    assert.strictEqual(await readFile(file, 'utf-8'), original);
  });

  it(
    'a short oldText matching thousands of times fails ambiguous quickly',
    { timeout: 5000 },
    async () => {
      const file = await writeTestFile(root, 'dense.txt', 'a b\n'.repeat(20_000));
      for (const ignoreWhitespace of [true, false]) {
        const result = await edit({
          path: file,
          ignoreWhitespace,
          edits: [{ oldText: 'a b', newText: 'X' }],
        });
        assert.strictEqual(result.isError, true, `ignoreWhitespace=${String(ignoreWhitespace)}`);
        assert.match(firstError(result)?.message ?? '', /matches at least \d+ places/i);
      }
      assert.strictEqual(await readFile(file, 'utf-8'), 'a b\n'.repeat(20_000));
    },
  );

  it('converts LF edit text to CRLF in a CRLF file', async () => {
    const literalFile = await writeTestFile(root, 'crlf/literal.txt', 'one\r\ntwo\r\nthree\r\n');
    const literalResult = await edit({
      path: literalFile,
      edits: [{ oldText: 'one\ntwo', newText: 'uno\ndos' }],
    });
    assert.notStrictEqual(literalResult.isError, true);
    assert.strictEqual(await readFile(literalFile, 'utf-8'), 'uno\r\ndos\r\nthree\r\n');

    const blankLineFile = await writeTestFile(root, 'crlf/blank-line.txt', 'a\r\n\r\nb\r\n');
    const blankLineResult = await edit({
      path: blankLineFile,
      edits: [{ oldText: 'a\n\nb', newText: 'c\n\nd' }],
      ignoreWhitespace: true,
    });
    assert.notStrictEqual(blankLineResult.isError, true);
    assert.strictEqual(await readFile(blankLineFile, 'utf-8'), 'c\r\n\r\nd\r\n');

    const mixedFile = await writeTestFile(root, 'crlf/mixed.txt', 'mixed\r\nlf\n');
    const mixedResult = await edit({
      path: mixedFile,
      edits: [{ oldText: 'mixed\nlf', newText: 'x' }],
    });
    assert.strictEqual(mixedResult.isError, true);
    assert.strictEqual(await readFile(mixedFile, 'utf-8'), 'mixed\r\nlf\n');
  });

  it('oldText typed with CRLF matches an all-CRLF file', async () => {
    const file = await writeTestFile(root, 'crlf/typed.txt', 'a\r\nb\r\nc\r\n');
    const result = await edit({ path: file, edits: [{ oldText: 'a\r\nb', newText: 'x' }] });
    assert.notStrictEqual(result.isError, true);
    assert.strictEqual(await readFile(file, 'utf-8'), 'x\r\nc\r\n');
  });

  it('a lone CR elsewhere in the file survives an edit', async () => {
    const file = await writeTestFile(root, 'crlf/lone-cr.txt', 'a\rb\r\nc\r\n');
    const result = await edit({ path: file, edits: [{ oldText: 'c', newText: 'd' }] });
    assert.notStrictEqual(result.isError, true);
    assert.strictEqual(await readFile(file, 'utf-8'), 'a\rb\r\nd\r\n');
  });

  it('oldText on line 1 of a BOM file matches and the mark stays', async () => {
    const file = await writeTestFile(root, 'bom/line1.txt', '\uFEFFa\nb\n');
    const result = await edit({ path: file, edits: [{ oldText: 'a\nb', newText: 'x' }] });
    assert.notStrictEqual(result.isError, true);
    assert.strictEqual(await readFile(file, 'utf-8'), '\uFEFFx\n');
  });

  it('a U+FEFF inside a BOM file matches as typed, and newText keeps its own', async () => {
    const file = await writeTestFile(root, 'bom/inner.txt', '\uFEFFfirst\n\uFEFFtarget\n');
    const result = await edit({
      path: file,
      edits: [{ oldText: '\uFEFFtarget', newText: 'done' }],
    });
    assert.notStrictEqual(result.isError, true);
    assert.strictEqual(await readFile(file, 'utf-8'), '\uFEFFfirst\ndone\n');

    const kept = await edit({ path: file, edits: [{ oldText: 'done', newText: '\uFEFFdone' }] });
    assert.notStrictEqual(kept.isError, true);
    assert.strictEqual(await readFile(file, 'utf-8'), '\uFEFFfirst\n\uFEFFdone\n');
  });

  it('a marked all-CRLF file matches oldText typed with the mark and CRLF', async () => {
    const file = await writeTestFile(root, 'bom/crlf.txt', '﻿a\r\nb\r\n');
    const result = await edit({
      path: file,
      edits: [{ oldText: '﻿a\r\nb', newText: '﻿x\r\nb' }],
    });
    assert.notStrictEqual(result.isError, true);
    assert.strictEqual(await readFile(file, 'utf-8'), '﻿x\r\nb\r\n');
  });

  it('a BOM-led oldText that matches only deeper in a BOM file is unmatched', async () => {
    const before = '\uFEFFa\nb\nc\nd\nx\n';
    const file = await writeTestFile(root, 'bom/deep.txt', before);
    const result = await edit({ path: file, edits: [{ oldText: '\uFEFFx', newText: '\uFEFFy' }] });
    assert.strictEqual(result.isError, true);
    assert.match(result.text ?? '', /no match for oldText/);
    assert.strictEqual(await readFile(file, 'utf-8'), before);
  });

  it("dryRun reports the file's own modified time", async () => {
    const file = await writeTestFile(root, 'edit_dry_mtime.txt', 'alpha\n');
    const old = new Date('2001-01-01T00:00:00Z');
    await utimes(file, old, old);
    const result = await edit({
      path: file,
      edits: [{ oldText: 'alpha', newText: 'ALPHA' }],
      dryRun: true,
    });
    assert.notStrictEqual(result.isError, true);
    assert.strictEqual(result.structured.results[0]?.value?.modified, '2001-01-01T00:00:00.000Z');
  });

  it('refuses a non-UTF-8 file and leaves its bytes intact', async () => {
    const path = join(root, 'late.txt');
    // First 512 bytes are plain ASCII; the bad byte (0xe9) lands past the binary probe.
    const bytes = Buffer.concat([
      Buffer.from('a'.repeat(600) + '\nhello\n'),
      Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]),
    ]);
    await writeFile(path, bytes);

    const edited = await edit({ path, edits: [{ oldText: 'hello', newText: 'bye' }] });
    assert.strictEqual(edited.isError, true);
    assert.strictEqual(firstError(edited)?.code, 'INVALID_INPUT');
    assert.deepStrictEqual(await readFile(path), bytes);
  });

  // edit authors its own text, so the structured half ships under `_meta`,
  // which a client like Claude Code never shows the model. The dry-run diff
  // and the unmatched oldText lived only there.
  it('puts the preview diff and the unmatched oldText in the text', async () => {
    const file = await writeTestFile(root, 'preview/0.txt', 'alpha\nbeta\n');
    const preview = await edit({
      path: file,
      dryRun: true,
      edits: [
        { oldText: 'alpha', newText: 'ALPHA' },
        { oldText: 'gamma', newText: 'x' },
      ],
    });
    const text = preview.text ?? '';
    assert.ok(text.includes('NO MATCH "gamma"'), text);
    assert.match(text, /^\+ALPHA$/mu);
    // Dry-run metadata describes the would-be file, and advertises no URI for
    // content that was never written.
    const value = preview.structured.results[0]?.value;
    assert.strictEqual(value?.size, 'ALPHA\nbeta\n'.length);
    assert.strictEqual(value?.resourceUri, undefined);
    assert.strictEqual(preview.resources, undefined);
    // A real edit fails the file instead, and must still say which oldText missed.
    const applied = await edit({ path: file, edits: [{ oldText: 'gamma', newText: 'x' }] });
    assert.match(applied.text ?? '', /no match for oldText "gamma"/);
  });

  // RE2 reports offsets in code points; JS strings index in UTF-16 code units,
  // so every astral character earlier in the file used to shift the splice.
  it('splices correctly past astral characters', async () => {
    const prefix = '# T\n\n> 🟢 a 🔺 b 📅 c\n\n';
    const file = await writeTestFile(root, 'emoji/rep.md', `${prefix}Line with ALPHA and more.\n`);
    const result = await edit({
      path: file,
      edits: [{ oldText: 'with ALPHA and', newText: 'with BETA and' }],
      ignoreWhitespace: true,
    });
    assert.notStrictEqual(result.isError, true);
    assert.strictEqual(await readFile(file, 'utf-8'), `${prefix}Line with BETA and more.\n`);
  });

  describe('write lock', () => {
    /** Holds `path`'s write lock until the returned release is called. */
    const holdLock = async (path: string) => {
      const gate = Promise.withResolvers<undefined>();
      const acquired = Promise.withResolvers<undefined>();
      const held = fs.lockForWrite(path, () => {
        acquired.resolve(undefined);
        return gate.promise;
      });
      await acquired.promise;
      return { release: () => gate.resolve(undefined), held };
    };

    it('a dry run previews through a held lock; a live run waits for it', async () => {
      const file = await writeTestFile(root, 'locked.txt', 'alpha\n');
      const edits = [{ oldText: 'alpha', newText: 'ALPHA' }];
      const { release, held } = await holdLock(file);
      let live: Promise<EditRun> | undefined;
      try {
        const dry = await edit({ path: file, edits, dryRun: true });
        assert.notStrictEqual(dry.isError, true);
        assert.match(dry.text ?? '', /^\+ALPHA$/mu);

        let settled = false;
        live = edit({ path: file, edits }).finally(() => {
          settled = true;
        });
        await sleep(50);
        assert.strictEqual(settled, false, 'a live edit must wait for the lock');
        assert.strictEqual(await readFile(file, 'utf-8'), 'alpha\n');
      } finally {
        release();
        await held;
      }
      assert.notStrictEqual((await live).isError, true);
      assert.strictEqual(await readFile(file, 'utf-8'), 'ALPHA\n');
    });

    it('30 concurrent edits on one file all apply (no lost updates)', async () => {
      const file = join(root, 'counters.txt');
      const n = 30;
      await writeFile(
        file,
        Array.from({ length: n }, (_, i) => `slot ${String(i)} = 0`).join('\n') + '\n',
      );
      const results = await Promise.all(
        Array.from({ length: n }, (_, i) =>
          edit({
            path: file,
            edits: [{ oldText: `slot ${String(i)} = 0`, newText: `slot ${String(i)} = 1` }],
          }),
        ),
      );
      assert.ok(
        results.every((r) => r.isError !== true),
        'every concurrent edit should succeed',
      );
      const after = await readFile(file, 'utf-8');
      for (let i = 0; i < n; i++) {
        assert.ok(after.includes(`slot ${String(i)} = 1`), `slot ${String(i)} must be updated`);
      }
      assert.ok(!after.includes('= 0'), 'no slot should keep its original value');
    });

    it('a batch naming one file through a symlinked parent applies both entries', async (t) => {
      const file = join(root, 'aliased.txt');
      await writeFile(file, 'AAA\nBBB\n');
      const alias = join(root, 'aliasdir');
      if (!(await trySymlink(root, alias, () => t.skip('symlinks not permitted')))) return;

      const result = await edit({
        files: [
          { path: file, edits: [{ oldText: 'AAA', newText: 'XXX' }] },
          { path: join(alias, 'aliased.txt'), edits: [{ oldText: 'BBB', newText: 'YYY' }] },
        ],
      });
      assert.notStrictEqual(result.isError, true);
      const after = await readFile(file, 'utf-8');
      assert.ok(after.includes('XXX') && after.includes('YYY'), `both edits must land: ${after}`);
    });
  });
});

// The pattern edit built before #157, kept as the oracle the regex-free
// matcher must agree with span for span. It runs on JS RegExp, whose
// leftmost-first semantics equal RE2's here: one re2-wasm compile per case
// made the test take seconds. Its horizontal class is widened from RE2's
// ASCII-only one to JS `\s` minus the newline and U+FEFF, as the matcher's is.
const H = '[\\t\\x0b\\f\\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]';

function newlineRunPattern(token: string, edge: { leading: boolean; trailing: boolean }): string {
  if (!edge.leading && !edge.trailing) return `(?:${H}*\\n)+${H}*`;
  const count = token.split('\n').length - 1;
  const lines = `(?:${H}*\\n){${String(count)}}`;
  return edge.trailing && token.endsWith('\n') ? lines : `${lines}${H}*`;
}

function oraclePattern(oldText: string): string {
  const tokens = oldText.split(/(\s+)/u);
  const last = tokens.length - 1;
  let pattern = '';
  for (const [i, token] of tokens.entries()) {
    if (i % 2 === 0) {
      pattern += RegExp.escape(token);
    } else if (token.includes('\n')) {
      pattern += newlineRunPattern(token, {
        leading: i === 1 && tokens[0] === '',
        trailing: i === last - 1 && tokens[last] === '',
      });
    } else if (/\w$/.test(tokens[i - 1] ?? '') && /^\w/.test(tokens[i + 1] ?? '')) {
      pattern += `${H}+`;
    } else {
      pattern += `${H}*`;
    }
  }
  return pattern;
}

const LIMIT = 6;

function oracle(content: string, oldText: string, from: number): FlexMatch[] {
  const found: FlexMatch[] = [];
  for (const match of content.slice(from).matchAll(new RegExp(oraclePattern(oldText), 'gu'))) {
    if (match[0].length === 0) continue;
    found.push({ start: from + match.index, length: match[0].length });
    if (found.length === LIMIT) break;
  }
  return found;
}

function take<T>(items: Iterable<T>, n: number): T[] {
  const out: T[] = [];
  for (const item of items) {
    if (out.length === n) break;
    out.push(item);
  }
  return out;
}

const PIECES = [
  'a',
  'b',
  'ab',
  '(',
  ';',
  ' ',
  '  ',
  '\t',
  '\n',
  '\n\n',
  ' \n',
  '\r\n',
  '\u00a0',
  '\u3000',
  '\u2028',
  '😀',
];

function* generatedCases(
  count: number,
): Generator<{ content: string; oldText: string; from: number }> {
  // Seeded LCG, so a failing case reproduces from its printed inputs.
  let seed = 157;
  const next = (n: number): number => {
    // 32-bit integer math: a float product past 2^53 loses its low bits.
    seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0;
    return (seed >>> 16) % n;
  };
  const pieces = (min: number, max: number): string[] =>
    Array.from({ length: min + next(max - min + 1) }, () => PIECES[next(PIECES.length)] ?? '');
  const spaces = PIECES.filter((piece) => /^\s+$/u.test(piece));
  let made = 0;
  while (made < count) {
    const parts = pieces(0, 40);
    const content = parts.join('');
    // Random text rarely matches anything, so most oldTexts are a slice of
    // the content with some whitespace runs swapped for others.
    const at = next(parts.length + 1);
    const slice = parts.slice(at, at + 1 + next(8));
    const oldText =
      next(4) === 0 || slice.length === 0
        ? pieces(1, 8).join('')
        : slice
            .map((piece) =>
              /^\s+$/u.test(piece) && next(2) === 0
                ? (spaces[next(spaces.length)] ?? piece)
                : piece,
            )
            .join('');
    if (!/\S/u.test(oldText)) continue;
    made += 1;
    const first = oracle(content, oldText, 0)[0];
    // edit resumes only on code-point boundaries; inside a surrogate pair RE2 offsets drift.
    const second = (content.codePointAt(0) ?? 0) > 0xffff ? 2 : 1;
    const froms = new Set([0, second, ...(first ? [first.start + first.length] : [])]);
    for (const from of froms) if (from <= content.length) yield { content, oldText, from };
  }
}

describe('flexMatches', () => {
  it('flexMatches treats every UTF-16 unit as the whitespace class says', () => {
    for (let code = 0; code <= 0xffff; code++) {
      const unit = String.fromCharCode(code);
      const horizontal = code !== 10 && code !== 0xfeff && /\s/u.test(unit);
      assert.strictEqual(
        [...flexMatches(`a${unit}b`, 'a b')].length,
        horizontal ? 1 : 0,
        `U+${code.toString(16)}`,
      );
    }
  });

  it('flexMatches equals the old flexible pattern on generated cases', () => {
    for (const { content, oldText, from } of generatedCases(3000)) {
      const got = take(flexMatches(content, oldText, from), LIMIT);
      assert.deepStrictEqual(
        got,
        oracle(content, oldText, from),
        JSON.stringify({ content, oldText, from }),
      );
    }
  });

  it('flexMatches applies a 5,000-line oldText', () => {
    const body = `${Array.from({ length: 5000 }, (_, i) => `    line_${String(i)} = value(${String(i)});`).join('\n')}\n`;
    assert.deepStrictEqual(
      [...flexMatches(body, body.replaceAll('    ', '  '))],
      [{ start: 0, length: body.length }],
    );
  });
});

describe('edit whitespace walk stays responsive', () => {
  let root: string;
  let file: string;
  let bytes: string;
  const old = `${'a '.repeat(8000)}b`;

  beforeEach(async () => {
    root = await createTestRoot();
    file = join(root, 'worst.txt');
    bytes = 'a '.repeat(80_000);
    await writeFile(file, bytes);
  });
  afterEach(async () => {
    await cleanupTestRoot(root);
  });

  const unchanged = async () => {
    assert.strictEqual(await readFile(file, 'utf8'), bytes);
  };
  const cancelAfter = (ms: number) => {
    const ctl = new AbortController();
    setTimeout(() => {
      ctl.abort();
    }, ms).unref();
    return ctl.signal;
  };
  const run = (args: EditArgs, signal?: AbortSignal) =>
    runToolBodyResult(EDIT, args, {
      roots: [root],
      ...(signal ? { signal } : {}),
    }) as Promise<EditRun>;

  it('keeps a timer firing during the walk', async () => {
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
    }, 10);
    try {
      await run(
        { path: file, edits: [{ oldText: old, newText: '' }], ignoreWhitespace: true },
        cancelAfter(300),
      );
    } finally {
      clearInterval(timer);
    }
    assert.ok(ticks >= 5, `ticks: ${String(ticks)}`);
    await unchanged();
  });

  it('a cancel ends the walk promptly', async () => {
    const t0 = Date.now();
    const result = await run(
      { path: file, edits: [{ oldText: old, newText: '' }], ignoreWhitespace: true },
      cancelAfter(200),
    );
    assert.ok(Date.now() - t0 < 2000);
    assert.strictEqual(result.isError, true);
    assert.strictEqual(firstError(result)?.code, 'CANCELLED');
    await unchanged();
  });

  it('a cancel on a later edit leaves the file unchanged', async () => {
    bytes = `first\n${'a '.repeat(80_000)}`;
    await writeFile(file, bytes);
    const t0 = Date.now();
    const result = await run(
      {
        path: file,
        edits: [
          { oldText: 'first', newText: '1st' },
          { oldText: old, newText: '' },
        ],
        ignoreWhitespace: true,
      },
      cancelAfter(200),
    );
    assert.ok(Date.now() - t0 < 2000);
    assert.strictEqual(result.isError, true);
    assert.strictEqual(firstError(result)?.code, 'CANCELLED');
    await unchanged();
  });

  it('a dry run walks responsively', async () => {
    const t0 = Date.now();
    const result = await run(
      { path: file, edits: [{ oldText: old, newText: '' }], ignoreWhitespace: true, dryRun: true },
      cancelAfter(200),
    );
    assert.ok(Date.now() - t0 < 2000);
    assert.strictEqual(result.isError, true);
    assert.strictEqual(firstError(result)?.code, 'CANCELLED');
    await unchanged();
  });

  it('past the deadline returns TIMEOUT', async (t) => {
    const prior = process.env['FS_TOOL_TIMEOUT_MS'];
    process.env['FS_TOOL_TIMEOUT_MS'] = '1000';
    t.after(() => {
      if (prior === undefined) delete process.env['FS_TOOL_TIMEOUT_MS'];
      else process.env['FS_TOOL_TIMEOUT_MS'] = prior;
    });
    const pair = await createTestClientPair([root]);
    t.after(() => pair.close());
    const t0 = Date.now();
    const result = await pair.client.callTool({
      name: 'edit',
      arguments: { path: file, edits: [{ oldText: old, newText: '' }], ignoreWhitespace: true },
    });
    assert.ok(Date.now() - t0 < 5000);
    assert.strictEqual(result.isError, true);
    const meta = result._meta as { results: { error?: { code: string } }[] };
    assert.strictEqual(meta.results[0]?.error?.code, 'TIMEOUT');
    assert.match(JSON.stringify(result.content), /timeout/iu);
    await unchanged();
  });

  it('refuses an oldText past the limit', async () => {
    const issues = await schemaIssues(
      runToolBodyResult(
        EDIT,
        { path: file, edits: [{ oldText: 'a'.repeat(1_048_577), newText: '' }] },
        { roots: [root] },
      ),
    );
    assert.ok(
      issues.some((m) => m.includes('1,048,576')),
      issues.join('; '),
    );
  });

  it('accepts an oldText at the limit', async () => {
    const result = await run({
      path: file,
      edits: [{ oldText: 'a'.repeat(1_048_576), newText: '' }],
    });
    assert.strictEqual(result.isError, true);
    assert.match(JSON.stringify(result.structured), /no match/u);
    await unchanged();
  });

  for (const ignoreWhitespace of [true, false]) {
    it(`keeps a timer firing and cancels promptly in a no-whitespace walk (ignoreWhitespace ${String(ignoreWhitespace)})`, async () => {
      bytes = 'a'.repeat(1_048_576);
      await writeFile(file, bytes);
      const oldText = `${'a'.repeat(8000)}b${'a'.repeat(7999)}`;
      let ticks = 0;
      const timer = setInterval(() => {
        ticks += 1;
      }, 10);
      const t0 = Date.now();
      try {
        const result = await run(
          { path: file, edits: [{ oldText, newText: '' }], ignoreWhitespace },
          cancelAfter(200),
        );
        assert.strictEqual(result.isError, true);
        assert.strictEqual(firstError(result)?.code, 'CANCELLED');
      } finally {
        clearInterval(timer);
      }
      assert.ok(Date.now() - t0 < 2000, `took ${String(Date.now() - t0)} ms`);
      assert.ok(ticks >= 5, `ticks: ${String(ticks)}`);
      await unchanged();
    });
  }

  it('many whitespace-flexible edits keep the loop responsive and cancel promptly', async () => {
    bytes = 'x'.repeat(10_400_000);
    await writeFile(file, bytes);
    const edits = Array.from({ length: 100 }, () => ({
      oldText: `${'x'.repeat(14)}y`,
      newText: '',
    }));
    let last = Date.now();
    let longest = 0;
    const timer = setInterval(() => {
      longest = Math.max(longest, Date.now() - last);
      last = Date.now();
    }, 10);
    const t0 = Date.now();
    try {
      const result = await run(
        { path: file, edits, ignoreWhitespace: true, dryRun: true },
        cancelAfter(500),
      );
      assert.strictEqual(firstError(result)?.code, 'CANCELLED');
    } finally {
      // A stall that ends the call clears the timer before it can fire and record the gap.
      longest = Math.max(longest, Date.now() - last);
      clearInterval(timer);
    }
    assert.ok(longest < 1000, `longest gap ${String(longest)} ms`);
    assert.ok(Date.now() - t0 < 2000, `took ${String(Date.now() - t0)} ms`);
    await unchanged();
  });

  it('findFrom equals indexOf', () => {
    const cases: [string, string, number][] = [
      ['abcabcabc', 'abc', 0],
      ['abcabcabc', 'abc', 1],
      ['abcabcabc', 'abc', 7],
      ['x😀y😀z', '😀', 0],
      ['x😀y😀z', '😀y', 2],
      ['aaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'a'.repeat(20), 3],
      [`${'a'.repeat(40)}b${'a'.repeat(40)}`, `${'a'.repeat(20)}b`, 0],
      ['abc', 'abcd', 0],
      ['abc', 'c', 5],
    ];
    for (const [content, literal, from] of cases) {
      const walk = findFrom(content, literal, from);
      let r = walk.next();
      while (!r.done) r = walk.next();
      assert.strictEqual(
        r.value,
        content.indexOf(literal, from),
        JSON.stringify([content, literal, from]),
      );
    }
  });
});
