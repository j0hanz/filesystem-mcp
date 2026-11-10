import assert from 'node:assert/strict';
import { chmod, link, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import type * as z from 'zod/v4';

import { ErrorCode, FsError } from '../src/core/errors.ts';
import { GuardedFileSystem } from '../src/core/fs.ts';
import { RE2_MAX_INPUT_BYTES } from '../src/core/matcher.ts';
import { MIB } from '../src/core/util.ts';
import { SEARCH_TEXT } from '../src/tools/index.ts';
import { REPLACE_TEXT } from '../src/tools/replace-text.ts';
import {
  cleanupTestRoot,
  createTestRoot,
  fsErrorMatcher,
  makeGuard,
  withEnv,
  writeTestFile,
} from './helpers.ts';
import { runToolBodyResult, schemaIssues, type ToolBodyOptions } from './tool-harness.ts';

type ReplaceArgs = z.input<typeof REPLACE_TEXT.def.input>;
interface Row {
  readonly path: string;
  readonly value?: { matches: number };
  readonly error?: { code: string; message: string };
}

const timeout = () => new DOMException('test timeout', 'TimeoutError');
const diffTargets = (diff: string | undefined): (string | undefined)[] =>
  [...(diff ?? '').matchAll(/^\+\+\+ ([^\t\n]+)/gmu)].map((m) => m[1]);

describe('replace_text body', () => {
  let root: string;
  let fs: GuardedFileSystem;

  beforeEach(async () => {
    root = await createTestRoot();
    fs = new GuardedFileSystem(await makeGuard([root]));
  });

  afterEach(async () => {
    await cleanupTestRoot(root);
  });

  const replace = async (args: ReplaceArgs, options: Partial<ToolBodyOptions> = {}) => {
    const result = await runToolBodyResult(REPLACE_TEXT, args, { fs, ...options });
    return { ...result, rows: result.structured.results as readonly Row[] };
  };

  it('names the changed files on a live run without returnDiff', async () => {
    await writeTestFile(root, 'a.txt', 'NEEDLE one\n');
    await writeTestFile(root, 'b.txt', 'NEEDLE two\n');
    const { text } = await replace({ path: root, searchPattern: 'NEEDLE', replacement: 'DONE' });
    // Walk order, not alphabetical: either roster order is valid.
    assert.match(text ?? '', /\/\/ changed: (?:a\.txt, b\.txt|b\.txt, a\.txt)/u);
  });

  it('names the changed files when the returned diff is truncated', async () => {
    const big = 'x'.repeat(30_000);
    await writeTestFile(root, 'big.txt', `${big}\n`);
    const { text } = await replace({
      path: join(root, 'big.txt'),
      searchPattern: 'x',
      replacement: 'y',
      returnDiff: true,
    });
    assert.match(text ?? '', /\/\/ changed: big\.txt/u);
  });

  it('quotes a changed file name that contains the roster separator', async () => {
    await writeTestFile(root, 'a, b.txt', 'NEEDLE\n');
    await writeTestFile(root, 'c.txt', 'NEEDLE\n');
    const { text } = await replace({ path: root, searchPattern: 'NEEDLE', replacement: 'DONE' });
    assert.match(text ?? '', /"a, b\.txt"/u);
    assert.match(text ?? '', /(?<!")c\.txt/u);
  });

  it('keeps absolute diff headers plain and same-named files apart', async () => {
    // Several roots with the working directory outside them print absolute paths.
    const other = await createTestRoot();
    try {
      await writeTestFile(root, 'a/index.html', 'needle\n');
      await writeTestFile(root, 'b/index.html', 'needle\n');
      const result = await replace(
        { path: root, searchPattern: 'needle', replacement: 'pin', dryRun: true },
        { fs: new GuardedFileSystem(await makeGuard([root, other])) },
      );

      const targets = diffTargets(result.structured.diff).sort();
      assert.strictEqual(targets.length, 2);
      assert.strictEqual(new Set(targets).size, 2);
      for (const target of targets) {
        assert.match(target ?? '', /^[^"\\]+\/[ab]\/index\.html$/u);
      }
    } finally {
      await cleanupTestRoot(other);
    }
  });

  it('says which default-named folder it skipped', async () => {
    await writeTestFile(root, 'build/gen.ts', 'needle\n');
    await writeTestFile(root, 'src/a.ts', 'other\n');
    const result = await replace({ path: root, searchPattern: 'needle', replacement: 'pin' });
    assert.ok(
      (result.text ?? '').includes(
        '// skipped 1 folder by default name (build); name it as path to rewrite it.',
      ),
    );
  });

  it('names a skipped folder so that following the advice reaches that folder', async () => {
    await writeTestFile(root, 'src/build/gen.ts', 'needle\n');
    await writeTestFile(root, 'build/other.ts', 'needle\n');
    const result = await replace({
      path: join(root, 'src'),
      searchPattern: 'needle',
      replacement: 'pin',
    });
    assert.match(result.text ?? '', /by default name \(src\/build\); name it as path/);
  });

  it('expands $ tokens exactly like String.prototype.replace', async () => {
    const twelve = '(a)(b)(c)(d)(e)(f)(g)(h)(i)(j)(k)(l)';
    const cases: { input: string; pattern: string; replacement: string }[] = [
      { input: 'xaby', pattern: '(a)(b)', replacement: '[$1|$2]' },
      { input: 'xaby', pattern: '(a)(b)', replacement: '<$&>' },
      { input: 'xaby', pattern: '(a)(b)', replacement: '{$`}' },
      { input: 'xaby', pattern: '(a)(b)', replacement: "{$'}" },
      { input: 'xaby', pattern: '(a)(b)', replacement: '$$1' },
      { input: 'xaby', pattern: '(a)', replacement: '$12' },
      { input: 'xaby', pattern: '(a)', replacement: '$0' },
      { input: 'xaby', pattern: '(a)', replacement: '$100' },
      { input: 'xaby', pattern: '(a)', replacement: 'end$' },
      { input: 'xaby', pattern: '(a)', replacement: '$3' },
      { input: 'abcdefghijkl', pattern: twelve, replacement: '$12' },
      { input: '\u{1F600}ab', pattern: '(a)', replacement: '$`' },
    ];
    for (const [i, c] of cases.entries()) {
      const file = await writeTestFile(root, `dollar/case${String(i)}.txt`, c.input);
      const result = await replace({
        path: file,
        searchPattern: c.pattern,
        replacement: c.replacement,
        isRegex: true,
      });
      assert.notStrictEqual(result.isError, true, `case ${String(i)} errored`);
      const expected = c.input.replace(new RegExp(c.pattern, 'g'), c.replacement);
      assert.strictEqual(
        await readFile(file, 'utf-8'),
        expected,
        `case ${String(i)}: ${c.replacement}`,
      );
    }

    // A case-insensitive literal search must keep the replacement verbatim.
    const literal = await writeTestFile(root, 'dollar/literal.txt', 'Alpha alpha');
    await replace({
      path: literal,
      searchPattern: 'ALPHA',
      replacement: '$1',
      caseSensitive: false,
    });
    assert.strictEqual(await readFile(literal, 'utf-8'), '$1 $1');
  });

  it('matches case exactly by default, and ignores case when asked', async () => {
    const file = await writeTestFile(root, 'case/default.txt', 'getUser GetUser GETUSER');
    const exact = await replace({ path: file, searchPattern: 'getUser', replacement: 'fetchUser' });
    assert.strictEqual(await readFile(file, 'utf-8'), 'fetchUser GetUser GETUSER');
    assert.strictEqual(exact.structured.totalMatches, 1);

    await writeFile(file, 'getUser GetUser GETUSER');
    await replace({ path: file, searchPattern: 'getUser', replacement: 'x', caseSensitive: false });
    assert.strictEqual(await readFile(file, 'utf-8'), 'x x x');
  });

  it('a pattern that differs only in case is zero matches, not an error', async () => {
    const file = await writeTestFile(root, 'case/only.txt', 'GetUser');
    const result = await replace({ path: file, searchPattern: 'getUser', replacement: 'x' });
    assert.notStrictEqual(result.isError, true);
    assert.strictEqual(result.structured.totalMatches, 0);
    assert.strictEqual(await readFile(file, 'utf-8'), 'GetUser');
  });

  it('case-insensitive literal replaces 300 matches in a 3 MB file well inside the deadline', async () => {
    const line = `${'x'.repeat(9990)} Needle\n`;
    const file = await writeTestFile(root, 'ci_literal/big.txt', line.repeat(300));
    const started = Date.now();
    const result = await replace({
      path: file,
      searchPattern: 'NEEDLE',
      replacement: 'pin',
      caseSensitive: false,
    });
    const elapsed = Date.now() - started;
    assert.notStrictEqual(result.isError, true);
    assert.strictEqual(result.structured.stoppedReason, undefined);
    assert.strictEqual(result.structured.totalMatches, 300);
    assert.ok(elapsed < 2000, `took ${String(elapsed)} ms`);
    assert.strictEqual(await readFile(file, 'utf-8'), `${'x'.repeat(9990)} pin\n`.repeat(300));
  });

  it('case-insensitive literal rewrites exactly what the escaped RE2 regex rewrites', async () => {
    const KELVIN = String.fromCodePoint(0x212a); // RE2 folds it onto k
    const LONG_S = String.fromCodePoint(0x017f); // RE2 folds it onto s
    const DOTTED_I = String.fromCodePoint(0x0130); // RE2 does not fold it onto i
    const EMOJI = String.fromCodePoint(0x1f600);
    const cases: { content: string; needle: string; matches: number }[] = [
      { content: `x ${KELVIN}ey key KEY\n`, needle: 'key', matches: 3 },
      { content: `${LONG_S}tate STATE state\n`, needle: 'state', matches: 3 },
      { content: `${DOTTED_I}d id ID\n`, needle: 'id', matches: 2 },
      { content: `${EMOJI}${EMOJI} Needle needle\n`, needle: 'needle', matches: 2 },
      { content: 'aaaa aAaA\n', needle: 'aa', matches: 4 },
      { content: 'line one\r\nLINE two\r\n', needle: 'line', matches: 2 },
      { content: 'STRASSE straße Straße\n', needle: 'Straße', matches: 2 },
      { content: 'É e E é\n', needle: 'e', matches: 2 },
      { content: 'a.b*c axbbc A.B*C\n', needle: 'a.b*c', matches: 2 },
    ];
    for (const [i, c] of cases.entries()) {
      const literal = await writeTestFile(root, `ci_parity/lit${String(i)}.txt`, c.content);
      const regex = await writeTestFile(root, `ci_parity/re${String(i)}.txt`, c.content);
      // '<$&>' must land verbatim from a literal; '<$$&>' is the same text from a regex.
      const lit = await replace({
        path: literal,
        searchPattern: c.needle,
        replacement: '<$&>',
        caseSensitive: false,
      });
      await replace({
        path: regex,
        searchPattern: RegExp.escape(c.needle),
        replacement: '<$$&>',
        isRegex: true,
        caseSensitive: false,
      });
      const rewritten = await readFile(literal, 'utf-8');
      assert.strictEqual(rewritten, await readFile(regex, 'utf-8'), `case ${String(i)}`);
      assert.strictEqual(lit.structured.totalMatches, c.matches, `case ${String(i)}: ${rewritten}`);
    }
  });

  it('regex mode on a file past the RE2 input cap fails that file with TOO_LARGE', async () => {
    const size = RE2_MAX_INPUT_BYTES + 1;
    const big = await writeTestFile(root, 'regex_cap/big.txt', 'x'.repeat(size - 5) + 'FIND\n');
    const asRegex = await replace({
      path: big,
      searchPattern: 'FIND',
      replacement: 'FOUND',
      isRegex: true,
    });
    assert.strictEqual(asRegex.isError, true);
    const failure = asRegex.rows[0]?.error;
    assert.strictEqual(failure?.code, 'TOO_LARGE');
    assert.match(failure?.message ?? '', /regex/i);
    assert.ok((await readFile(big, 'utf-8')).endsWith('FIND\n'), 'file must be untouched');

    const literal = await replace({
      path: big,
      searchPattern: 'FIND',
      replacement: 'FOUND',
      caseSensitive: true,
    });
    assert.notStrictEqual(literal.isError, true, 'the literal matcher has no input cap');
    assert.ok((await readFile(big, 'utf-8')).endsWith('FOUND\n'));
  });

  it('transforms a hard-linked file once per run, dry run and live alike', async (t) => {
    const a = await writeTestFile(root, 'hardlink_once/a.txt', 'x\n');
    const b = join(dirname(a), 'b.txt');
    try {
      await link(a, b);
    } catch (error) {
      t.skip(`hard links not supported here: ${String(error)}`);
      return;
    }
    const totalMatches = async (dryRun: boolean) => {
      const result = await replace({
        path: dirname(a),
        searchPattern: 'x',
        replacement: 'xx',
        caseSensitive: true,
        dryRun,
      });
      assert.notStrictEqual(result.isError, true, `dryRun=${String(dryRun)}`);
      return result.structured.totalMatches;
    };
    assert.strictEqual(await totalMatches(true), 1, 'dry run counts the shared bytes once');
    assert.strictEqual(await totalMatches(false), 1, 'live run counts the shared bytes once');
    assert.strictEqual(await readFile(a, 'utf-8'), 'xx\n');
    assert.strictEqual(await readFile(b, 'utf-8'), 'xx\n');
  });

  it('converts LF literal text to CRLF in a CRLF file', async () => {
    const call = async (args: ReplaceArgs) => {
      const result = await replace(args);
      assert.notStrictEqual(result.isError, true);
      return result.structured.totalMatches;
    };

    // Case-sensitive literal: the Buffer matcher.
    const sensitive = await writeTestFile(root, 'rt-crlf/sensitive.txt', 'one\r\ntwo\r\nthree\r\n');
    assert.strictEqual(
      await call({
        path: sensitive,
        searchPattern: 'one\ntwo',
        replacement: 'uno\ndos',
        caseSensitive: true,
      }),
      1,
    );
    assert.strictEqual(await readFile(sensitive, 'utf-8'), 'uno\r\ndos\r\nthree\r\n');

    // caseSensitive: false compiles an RE2 regex from the escaped literal.
    const insensitive = await writeTestFile(root, 'rt-crlf/insensitive.txt', 'One\r\nTwo\r\n');
    assert.strictEqual(
      await call({
        path: insensitive,
        searchPattern: 'one\ntwo',
        replacement: 'x\ny',
        caseSensitive: false,
      }),
      1,
    );
    assert.strictEqual(await readFile(insensitive, 'utf-8'), 'x\r\ny\r\n');

    // A leading newline must take the \r with it, not leave \r\r\n.
    const leading = await writeTestFile(root, 'rt-crlf/leading.txt', 'a\r\nb\r\n');
    assert.strictEqual(
      await call({ path: leading, searchPattern: '\nb', replacement: '\nc', caseSensitive: true }),
      1,
    );
    assert.strictEqual(await readFile(leading, 'utf-8'), 'a\r\nc\r\n');

    // A single-line pattern with a multi-line replacement keeps the file all-CRLF.
    const grow = await writeTestFile(root, 'rt-crlf/grow.txt', 'one\r\ntwo\r\n');
    assert.strictEqual(
      await call({
        path: grow,
        searchPattern: 'two',
        replacement: 'two\nhalf',
        caseSensitive: true,
      }),
      1,
    );
    assert.strictEqual(await readFile(grow, 'utf-8'), 'one\r\ntwo\r\nhalf\r\n');

    // Mixed endings have no one ending to convert to: nothing matches, file untouched.
    const mixed = await writeTestFile(root, 'rt-crlf/mixed/mixed.txt', 'mixed\r\nlf\n');
    await call({ path: mixed, searchPattern: 'mixed\nlf', replacement: 'x', caseSensitive: true });
    assert.strictEqual(await readFile(mixed, 'utf-8'), 'mixed\r\nlf\n');

    // isRegex is taken as written: \n does not match \r\n.
    const regex = await writeTestFile(root, 'rt-crlf/regex/regex.txt', 'one\r\ntwo\r\n');
    await call({ path: regex, searchPattern: 'one\\ntwo', replacement: 'x', isRegex: true });
    assert.strictEqual(await readFile(regex, 'utf-8'), 'one\r\ntwo\r\n');

    // One directory run picks the ending per file.
    const crlfFile = await writeTestFile(root, 'rt-crlf/dir/crlf.txt', 'p\r\nq\r\n');
    const lfFile = await writeTestFile(root, 'rt-crlf/dir/lf.txt', 'p\nq\n');
    assert.strictEqual(
      await call({ path: join(root, 'rt-crlf/dir'), searchPattern: 'p\nq', replacement: 'r\ns' }),
      2,
    );
    assert.strictEqual(await readFile(crlfFile, 'utf-8'), 'r\r\ns\r\n');
    assert.strictEqual(await readFile(lfFile, 'utf-8'), 'r\ns\n');
  });

  it("honors the allowed root's .gitignore below it", async () => {
    // root is the allowed root; the walk is scoped to a subdirectory.
    await writeFile(join(root, '.gitignore'), 'scoped_ignored/*.log\n');
    const sub = join(root, 'scoped_ignored');
    const kept = await writeTestFile(root, 'scoped_ignored/keep.txt', 'NEEDLE_G\n');
    const dropped = await writeTestFile(root, 'scoped_ignored/drop.log', 'NEEDLE_G\n');

    const replaced = await replace({ path: sub, searchPattern: 'NEEDLE_G', replacement: 'X' });
    assert.notStrictEqual(replaced.isError, true);
    assert.strictEqual(await readFile(kept, 'utf-8'), 'X\n');
    assert.strictEqual(await readFile(dropped, 'utf-8'), 'NEEDLE_G\n', 'ignored file untouched');
  });

  describe('size limits', () => {
    const limit = 1024 * 1024;

    it('refuses a named file over the text size limit', async () => {
      await withEnv({ FS_MAX_FILE_SIZE: String(limit) }, async () => {
        const big = await writeTestFile(root, 'size_cap/big.txt', 'FIND\n' + 'x'.repeat(limit));
        await assert.rejects(
          replace({ path: big, searchPattern: 'FIND', replacement: 'FOUND' }),
          fsErrorMatcher(ErrorCode.TOO_LARGE, /^File too large for replace_text/),
        );
        assert.ok((await readFile(big, 'utf-8')).startsWith('FIND\n'), 'file must be untouched');
      });
    });

    it('counts walked files over the text size limit in skippedTooLarge', async () => {
      await withEnv({ FS_MAX_FILE_SIZE: String(limit) }, async () => {
        const dir = join(root, 'size_cap_rows');
        const a = await writeTestFile(dir, 'a/big.txt', 'FIND\n' + 'x'.repeat(limit));
        const b = await writeTestFile(dir, 'b/big.txt', 'FIND\n' + 'x'.repeat(limit));
        const swept = await replace({ path: dir, searchPattern: 'FIND', replacement: 'FOUND' });
        assert.notStrictEqual(swept.isError, true);
        assert.strictEqual(swept.structured.skippedTooLarge, 2);
        assert.strictEqual(swept.structured.summary.failed, 0);
        assert.match(swept.text ?? '', /\/\/ skipped 2 files over the text size limit/);
        assert.ok((await readFile(a, 'utf-8')).startsWith('FIND\n'));
        assert.ok((await readFile(b, 'utf-8')).startsWith('FIND\n'));
      });
    });

    it('refuses a $` expansion that grows a file past the text size limit, dry run included', async () => {
      await withEnv({ FS_MAX_FILE_SIZE: String(limit) }, async () => {
        // 2 KiB of 'a' with $` per match grows quadratically: about 2 MB uncapped, past the 1 MiB limit.
        // Small enough that each RE2 exec stays cheap under coverage instrumentation.
        const original = 'a'.repeat(2 * 1024);
        const file = await writeTestFile(root, 'out_cap/prefix.txt', original);
        for (const dryRun of [true, false]) {
          const refused = await replace({
            path: file,
            searchPattern: 'a',
            replacement: '$`',
            isRegex: true,
            dryRun,
          });
          assert.strictEqual(refused.isError, true, `dryRun=${String(dryRun)}`);
          const failure = refused.rows[0]?.error;
          assert.strictEqual(failure?.code, 'TOO_LARGE');
          assert.strictEqual(
            failure?.message,
            'Replacement result exceeds the size limit (more than 1048576 bytes)',
          );
          assert.match(refused.text ?? '', /prefix\.txt: TOO_LARGE Replacement result exceeds/);
          assert.strictEqual(await readFile(file, 'utf-8'), original, 'file must be untouched');
        }
      });
    });

    it('fails only the walked file whose literal replacement outgrows the limit', async () => {
      await withEnv({ FS_MAX_FILE_SIZE: String(limit) }, async () => {
        const dir = join(root, 'out_cap_walk');
        // 1000 matches x 2000 chars = 2,000,000 bytes > 1 MiB.
        const blow = await writeTestFile(dir, 'blow.txt', 'x'.repeat(1000));
        const ok = await writeTestFile(dir, 'ok.txt', 'x\n');
        const swept = await replace({
          path: dir,
          searchPattern: 'x',
          replacement: 'y'.repeat(2000),
          caseSensitive: true,
        });
        assert.notStrictEqual(swept.isError, true);
        assert.deepStrictEqual(swept.structured.summary, { total: 2, succeeded: 1, failed: 1 });
        assert.strictEqual(swept.rows.find((r) => r.error)?.error?.code, 'TOO_LARGE');
        assert.strictEqual(await readFile(blow, 'utf-8'), 'x'.repeat(1000));
        assert.strictEqual(await readFile(ok, 'utf-8'), 'y'.repeat(2000) + '\n');
      });
    });

    it('caps the result in UTF-8 bytes, not UTF-16 units, and allows exactly the limit', async () => {
      await withEnv({ FS_MAX_FILE_SIZE: String(limit) }, async () => {
        // '€' is 1 UTF-16 unit but 3 UTF-8 bytes: 349526 of them are 1048578 bytes.
        const over = await writeTestFile(root, 'out_cap_utf8/over.txt', 'a'.repeat(349526));
        const refused = await replace({
          path: over,
          searchPattern: 'a',
          replacement: '€',
          caseSensitive: true,
        });
        assert.strictEqual(refused.isError, true);
        assert.strictEqual(refused.rows[0]?.error?.code, 'TOO_LARGE');
        assert.strictEqual(await readFile(over, 'utf-8'), 'a'.repeat(349526));

        // 349525 x '€' plus one 'b' is exactly 1048576 bytes: at the limit, not over it.
        const exact = await writeTestFile(root, 'out_cap_utf8/exact.txt', 'a'.repeat(349525) + 'b');
        const allowed = await replace({
          path: exact,
          searchPattern: 'a',
          replacement: '€',
          caseSensitive: true,
        });
        assert.notStrictEqual(allowed.isError, true);
        assert.strictEqual((await stat(exact)).size, limit);
      });
    });

    it('does not report a cut for a named file refused as too large', async () => {
      const file = await writeTestFile(root, 'replace_cut_toolarge/a.txt', 'x'.repeat(1000));
      await withEnv({ FS_MAX_FILE_SIZE: String(limit) }, async () => {
        const result = await replace({
          path: file,
          searchPattern: 'x',
          replacement: 'y'.repeat(2000),
          caseSensitive: true,
          maxMatches: 999,
        });
        assert.strictEqual(result.isError, true);
        assert.strictEqual(result.rows[0]?.error?.code, 'TOO_LARGE');
        assert.strictEqual(await readFile(file, 'utf8'), 'x'.repeat(1000));
        assert.notStrictEqual(result.structured.stoppedReason, 'maxMatches');
      });
    });

    it('does not report a cut when the UTF-8 size check refuses a capped file', async () => {
      // Two-byte replacement: the UTF-16 check passes at 999 matches, the UTF-8 check after the matcher does not.
      const file = await writeTestFile(root, 'replace_cut_utf8/a.txt', 'x'.repeat(1000));
      await withEnv({ FS_MAX_FILE_SIZE: String(limit) }, async () => {
        const result = await replace({
          path: file,
          searchPattern: 'x',
          replacement: 'é'.repeat(1000),
          caseSensitive: true,
          maxMatches: 999,
        });
        assert.strictEqual(result.isError, true);
        assert.strictEqual(result.rows[0]?.error?.code, 'TOO_LARGE');
        assert.strictEqual(await readFile(file, 'utf8'), 'x'.repeat(1000));
        assert.notStrictEqual(result.structured.stoppedReason, 'maxMatches');
      });
    });
  });

  it('failure rows name same-named files by their full relative paths', async () => {
    const dir = join(root, 'regex_cap_rows');
    const body = 'x'.repeat(RE2_MAX_INPUT_BYTES + 1 - 5) + 'FIND\n';
    await writeTestFile(dir, 'a/big.txt', body);
    await writeTestFile(dir, 'b/big.txt', body);
    const swept = await replace({
      path: dir,
      searchPattern: 'FIND',
      replacement: 'FOUND',
      isRegex: true,
    });
    assert.strictEqual(swept.isError, true);
    assert.match(swept.text ?? '', /a\/big\.txt: TOO_LARGE/);
    assert.match(swept.text ?? '', /b\/big\.txt: TOO_LARGE/);
  });

  describe('binary files', () => {
    it('counts a walked binary file without a match', async () => {
      const dir = join(root, 'binrep_nomatch');
      await writeTestFile(dir, 'text.txt', 'foo\n');
      await writeFile(join(dir, 'blob.bin'), Buffer.from([0x01, 0x00, 0x02]));
      const swept = await replace({ path: dir, searchPattern: 'foo', replacement: 'bar' });
      assert.strictEqual(swept.structured.skippedBinary, 1);
    });

    it('refuses a named binary file without a match', async () => {
      const blob = join(root, 'binrep_named/blob.bin');
      await mkdir(dirname(blob), { recursive: true });
      await writeFile(blob, Buffer.from([0x01, 0x00, 0x02]));
      await assert.rejects(
        replace({ path: blob, searchPattern: 'zzz', replacement: 'bar' }),
        fsErrorMatcher(ErrorCode.BINARY_FILE),
      );
    });

    it('refuses a named binary file on a dry run', async () => {
      const blob = join(root, 'binrep_named_dry/blob.bin');
      await mkdir(dirname(blob), { recursive: true });
      await writeFile(blob, Buffer.from([0x01, 0x00, 0x02]));
      await assert.rejects(
        replace({ path: blob, searchPattern: 'zzz', replacement: 'bar', dryRun: true }),
        fsErrorMatcher(ErrorCode.BINARY_FILE),
      );
    });

    it('refuses a named late non-UTF-8 file', async () => {
      const file = join(root, 'binrep_named_late/late.txt');
      await mkdir(dirname(file), { recursive: true });
      await writeFile(
        file,
        Buffer.concat([Buffer.alloc(600, 'a'), Buffer.from('\nfoo'), Buffer.from([0xe9, 0x0a])]),
      );
      await assert.rejects(
        replace({ path: file, searchPattern: 'foo', replacement: 'bar' }),
        fsErrorMatcher(ErrorCode.INVALID_INPUT, /non-UTF-8/),
      );
    });

    // Decoding these as UTF-8 and writing the result back swaps every invalid
    // byte for U+FFFD, corrupting the file even though the match itself is ASCII.
    it('leaves binary and non-UTF-8 files untouched', async () => {
      const dir = join(root, 'binrep');
      const text = await writeTestFile(dir, 'text.txt', 'foo\n');
      // Valid UTF-8 with a NUL, so each file trips one half of the guard.
      const blob = Buffer.from([0x66, 0x6f, 0x6f, 0x00, 0x01]);
      const latin1 = Buffer.from('café foo\n', 'latin1');
      await writeFile(join(dir, 'blob.bin'), blob);
      await writeFile(join(dir, 'latin1.txt'), latin1);

      const swept = await replace({ path: dir, searchPattern: 'foo', replacement: 'bar' });
      assert.notStrictEqual(swept.isError, true);
      assert.strictEqual(swept.structured.summary.failed, 0);
      assert.strictEqual(swept.structured.skippedBinary, 2);
      assert.match(swept.text ?? '', /\/\/ skipped 2 binary files/);
      assert.strictEqual(await readFile(text, 'utf-8'), 'bar\n');
      assert.deepStrictEqual(await readFile(join(dir, 'blob.bin')), blob);
      assert.deepStrictEqual(await readFile(join(dir, 'latin1.txt')), latin1);

      // Named explicitly, the file is the whole request: refuse it, don't skip.
      await assert.rejects(
        replace({ path: join(dir, 'blob.bin'), searchPattern: 'foo', replacement: 'bar' }),
        fsErrorMatcher(ErrorCode.BINARY_FILE),
      );
      assert.deepStrictEqual(await readFile(join(dir, 'blob.bin')), blob);
    });
  });

  describe('inaccessible entries', () => {
    const posixOnly = (t: { skip: (message: string) => void }): boolean => {
      if (process.platform === 'win32' || process.getuid?.() === 0) {
        t.skip('needs POSIX permissions as non-root');
        return false;
      }
      return true;
    };

    it('counts an unreadable directory', async (t) => {
      if (!posixOnly(t)) return;
      const dir = join(root, 'replace_locked');
      const locked = join(dir, 'locked');
      await writeTestFile(dir, 'a.ts', 'needle');
      await writeTestFile(dir, 'locked/x.ts', 'needle');
      await chmod(locked, 0o000);
      try {
        const result = await replace({
          path: dir,
          searchPattern: 'needle',
          replacement: 'pin',
          dryRun: true,
        });
        assert.strictEqual(result.structured.skippedInaccessible, 1);
        assert.strictEqual(result.structured.summary.failed, 0);
        assert.match(result.text ?? '', /1 inaccessible entry/u);
        assert.doesNotMatch(result.text ?? '', /no files were searched/u);
      } finally {
        await chmod(locked, 0o755);
      }
    });

    it('counts an EACCES file instead of failing it', async (t) => {
      if (!posixOnly(t)) return;
      const dir = join(root, 'replace_eacces');
      await writeTestFile(dir, 'a.txt', 'needle');
      const b = await writeTestFile(dir, 'b.txt', 'needle');
      await chmod(b, 0o000);
      try {
        const result = await replace({
          path: dir,
          searchPattern: 'needle',
          replacement: 'pin',
          dryRun: true,
        });
        assert.strictEqual(result.structured.skippedInaccessible, 1);
        assert.strictEqual(result.structured.summary.failed, 0);
      } finally {
        await chmod(b, 0o644);
      }
    });

    it('maxFiles frees the slot of an EACCES file', async (t) => {
      if (!posixOnly(t)) return;
      const dir = join(root, 'replace_max_files_eacces');
      await writeTestFile(dir, 'a.txt', 'needle');
      await writeTestFile(dir, 'b.txt', 'needle');
      // The walk follows readdir order: lock whichever file it visits first.
      const [lockedName = '', readableName = ''] = await readdir(dir);
      const locked = join(dir, lockedName);
      await chmod(locked, 0o000);
      try {
        const result = await replace({
          path: dir,
          searchPattern: 'needle',
          replacement: 'pin',
          maxFiles: 1,
        });
        assert.strictEqual(result.structured.skippedInaccessible, 1);
        assert.strictEqual(result.structured.stoppedReason, undefined);
        assert.strictEqual(await readFile(join(dir, readableName), 'utf-8'), 'pin');
      } finally {
        await chmod(locked, 0o644);
      }
    });
  });

  describe('walk order', () => {
    it('results and diff follow walk order', async (t) => {
      const dir = join(root, 'replace_walk_order');
      for (let i = 0; i < 12; i++) {
        await writeTestFile(dir, `a${String(i).padStart(2, '0')}.txt`, 'needle\n');
      }
      // The walk follows the directory's own order, which only NTFS sorts.
      const first = (await readdir(dir))[0] ?? '';
      const realOpen = fs.open.bind(fs);
      let opened = 0;
      const othersOpened = Promise.withResolvers<undefined>();
      t.mock.method(fs, 'open', async (...a: Parameters<GuardedFileSystem['open']>) => {
        if (basename(dirname(a[0])) === 'replace_walk_order') {
          // Three others: fewer than the smallest pool (4) and scan window (8),
          // which hold later files back until the first one settles.
          if (++opened === 4) othersOpened.resolve(undefined);
          // The walk's first file finishes last.
          if (basename(a[0]) === first) await othersOpened.promise;
        }
        return realOpen(...a);
      });
      const result = await replace({
        path: dir,
        searchPattern: 'needle',
        replacement: 'pin',
        dryRun: true,
      });
      assert.strictEqual(result.rows[0]?.path, `replace_walk_order/${first}`);
      assert.strictEqual(diffTargets(result.structured.diff)[0], `replace_walk_order/${first}`);
    });

    it('interleaves changed and failure results in walk order', async (t) => {
      const dir = join(root, 'replace_mixed_walk_order');
      await writeTestFile(dir, 'a.txt', 'needle\n');
      await writeTestFile(dir, 'b.txt', 'needle\n');
      const order = await readdir(dir);
      const realOpen = fs.open.bind(fs);
      t.mock.method(fs, 'open', async (...a: Parameters<GuardedFileSystem['open']>) => {
        // By name: the guard lower-cases a Windows drive letter, so a joined path never matches.
        if (basename(dirname(a[0])) === 'replace_mixed_walk_order' && basename(a[0]) === order[0]) {
          throw new FsError(ErrorCode.TOO_LARGE, 'File exceeds size limit', a[0]);
        }
        return realOpen(...a);
      });
      const result = await replace({
        path: dir,
        searchPattern: 'needle',
        replacement: 'pin',
        dryRun: true,
      });
      assert.deepStrictEqual(
        result.rows.map((r) => r.path),
        order.map((name) => `replace_mixed_walk_order/${name}`),
      );
      assert.strictEqual(result.rows[0]?.error?.code, 'TOO_LARGE');
      assert.strictEqual(result.rows[1]?.value?.matches, 1);
    });

    it('keeps the walk-first failure rows and holds no error past its entry', async (t) => {
      const dir = join(root, 'replace_failures');
      const count = 25;
      for (let i = 0; i < count; i++) {
        await writeTestFile(dir, `f${String(i).padStart(2, '0')}.txt`, 'needle\n');
      }
      // The walk follows the directory's own order, which only NTFS sorts.
      const order = (await readdir(dir)).map((name) => `replace_failures/${name}`);
      const realOpen = fs.open.bind(fs);
      let opened = 0;
      const othersOpened = Promise.withResolvers<undefined>();
      t.mock.method(fs, 'open', async (...a: Parameters<GuardedFileSystem['open']>) => {
        if (basename(dirname(a[0])) !== 'replace_failures') return realOpen(...a);
        // Three others: fewer than the smallest pool (4), so the walk's first file fails last.
        if (++opened === 4) othersOpened.resolve(undefined);
        if (`replace_failures/${basename(a[0])}` === order[0]) await othersOpened.promise;
        throw new FsError(ErrorCode.TOO_LARGE, 'File exceeds size limit', a[0]);
      });
      // Whatever scan keeps until the walk ends goes through its results Map.
      // eslint-disable-next-line @typescript-eslint/unbound-method -- re-applied with `this` below
      const realSet = Map.prototype.set;
      let heldErrors = 0;
      t.mock.method(
        Map.prototype,
        'set',
        function (this: Map<unknown, unknown>, k: unknown, v: unknown) {
          if (typeof v === 'object' && v !== null && 'kind' in v && 'error' in v) heldErrors++;
          return realSet.call(this, k, v);
        },
      );
      const result = await replace({
        path: dir,
        searchPattern: 'needle',
        replacement: 'pin',
        dryRun: true,
      });
      t.mock.restoreAll();
      assert.strictEqual(result.isError, true);
      assert.deepStrictEqual(
        result.rows.map((r) => r.path),
        order.slice(0, 20),
      );
      assert.ok(result.rows.every((r) => r.error?.code === 'TOO_LARGE'));
      assert.deepStrictEqual(result.structured.summary, {
        total: count,
        succeeded: 0,
        failed: count,
      });
      assert.strictEqual(result.structured.resultsTruncated, true);
      assert.strictEqual(heldErrors, 0);
    });
  });

  describe('diff budget', () => {
    const lines = (n: number): string =>
      Array.from({ length: n }, (_, i) => `needle line ${String(i)} xxxxx`).join('\n');
    const dryRun = (path: string) =>
      replace({ path, searchPattern: 'needle', replacement: 'pin', dryRun: true });

    it('marks a diff cut by its budget', async () => {
      const dir = join(root, 'replace_diff_budget');
      // Each patch is just over 12 KiB, so the two together exceed the 20 KiB budget.
      await writeTestFile(dir, 'a.txt', lines(300));
      await writeTestFile(dir, 'b.txt', lines(300));
      const result = await dryRun(dir);
      assert.strictEqual(result.structured.diffTruncated, true);
      // The walk's first file keeps its diff; only NTFS sorts that to a.txt.
      const first = (await readdir(dir))[0];
      assert.deepStrictEqual(diffTargets(result.structured.diff), [
        `replace_diff_budget/${first ?? ''}`,
      ]);
    });

    it('does not depend on completion order', async (t) => {
      // Patches of about 12 KiB, 12 KiB and 1 KiB in walk order: the second
      // never fits beside the first, and the third always does.
      const setup = async (name: string): Promise<string[]> => {
        const dir = join(root, name);
        for (const file of ['a.txt', 'b.txt', 'c.txt']) await writeTestFile(dir, file, 'x');
        // The walk follows readdir order, which only NTFS sorts.
        const order = await readdir(dir);
        await writeTestFile(dir, order[0] ?? '', lines(300));
        await writeTestFile(dir, order[1] ?? '', lines(300));
        await writeTestFile(dir, order[2] ?? '', 'needle\n');
        return order;
      };
      const walkFirst = await setup('replace_budget_walk_first');
      const smallFirst = await setup('replace_budget_small_first');
      const realOpen = fs.open.bind(fs);
      t.mock.method(fs, 'open', async (...a: Parameters<GuardedFileSystem['open']>) => {
        const run = basename(dirname(a[0]));
        const name = basename(a[0]);
        // One run finishes in walk order, the other finishes the small third file first.
        if (run === 'replace_budget_walk_first' && name === walkFirst[2]) await sleep(100);
        if (run === 'replace_budget_small_first' && name !== smallFirst[2]) await sleep(100);
        return realOpen(...a);
      });
      for (const [name, order] of [
        ['replace_budget_walk_first', walkFirst],
        ['replace_budget_small_first', smallFirst],
      ] as const) {
        const result = await dryRun(join(root, name));
        assert.strictEqual(result.structured.diffTruncated, true, name);
        assert.deepStrictEqual(
          diffTargets(result.structured.diff),
          [`${name}/${order[0] ?? ''}`, `${name}/${order[2] ?? ''}`],
          name,
        );
      }
    });

    it('keeps a patch a slower lower patch would leave room for', async (t) => {
      // Walk-order patches of about 10, 15 and 8 KiB: first-fit keeps the first
      // and third. Finishing the second, then the third, then the first must
      // not refuse the third against the second, which the first later displaces.
      const dir = join(root, 'replace_budget_displaced');
      for (const file of ['a.txt', 'b.txt', 'c.txt']) await writeTestFile(dir, file, 'x');
      // The walk follows readdir order, which only NTFS sorts.
      const order = await readdir(dir);
      await writeTestFile(dir, order[0] ?? '', lines(250));
      await writeTestFile(dir, order[1] ?? '', lines(375));
      await writeTestFile(dir, order[2] ?? '', lines(200));
      const realOpen = fs.open.bind(fs);
      t.mock.method(fs, 'open', async (...a: Parameters<GuardedFileSystem['open']>) => {
        const name = basename(a[0]);
        if (name === order[0]) await sleep(200);
        if (name === order[2]) await sleep(100);
        return realOpen(...a);
      });
      const result = await dryRun(dir);
      assert.strictEqual(result.structured.diffTruncated, true);
      assert.deepStrictEqual(diffTargets(result.structured.diff), [
        `replace_budget_displaced/${order[0] ?? ''}`,
        `replace_budget_displaced/${order[2] ?? ''}`,
      ]);
    });

    it('keeps the walk-first diffs that fit and skips the rest', async () => {
      const dir = join(root, 'replace_diff_prefix');
      // Each patch is about 5.6 KiB: three fit the 20 KiB budget, a fourth does not.
      for (const name of ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt']) {
        await writeTestFile(dir, name, lines(130));
      }
      const result = await dryRun(dir);
      assert.strictEqual(result.structured.diffTruncated, true);
      // fs.glob walks in readdir order.
      const walked = (await readdir(dir)).slice(0, 3).map((name) => `replace_diff_prefix/${name}`);
      assert.deepStrictEqual(diffTargets(result.structured.diff), walked);
    });

    it('drops a diff over the whole budget and keeps a small one', async () => {
      const dir = join(root, 'replace_diff_huge');
      // About 30 KiB of patch alone, past the 20 KiB budget.
      await writeTestFile(dir, 'huge.txt', lines(700));
      await writeTestFile(dir, 'small.txt', 'needle\n');
      const result = await dryRun(dir);
      assert.strictEqual(result.structured.diffTruncated, true);
      assert.deepStrictEqual(diffTargets(result.structured.diff), ['replace_diff_huge/small.txt']);
    });
  });

  describe('caps', () => {
    it('maxFiles ignores skipped entries', async () => {
      const dir = join(root, 'replace_max_files');
      await writeTestFile(dir, '.env', 'needle');
      await writeTestFile(dir, 'a.txt', 'needle');
      await writeTestFile(dir, 'b.txt', 'needle');
      const result = await replace({
        path: dir,
        searchPattern: 'needle',
        replacement: 'pin',
        dryRun: true,
        includeHidden: true,
        maxFiles: 2,
      });
      assert.strictEqual(result.structured.summary.succeeded, 2);
      assert.strictEqual(result.structured.stoppedReason, undefined);
    });

    it('a maxFiles stop keeps its reason', async () => {
      const dir = join(root, 'replace_max_files_stop');
      await writeTestFile(dir, 'a.txt', 'needle');
      await writeTestFile(dir, 'b.txt', 'needle');
      const result = await replace({
        path: dir,
        searchPattern: 'needle',
        replacement: 'pin',
        dryRun: true,
        maxFiles: 1,
      });
      assert.strictEqual(result.structured.stoppedReason, 'maxFiles');
    });

    it('a dry run stopped by maxFiles keeps the higher-limit advice', async () => {
      const dir = join(root, 'replace_max_files_advice');
      await writeTestFile(dir, 'a.txt', 'needle');
      await writeTestFile(dir, 'b.txt', 'needle');
      const result = await replace({
        path: dir,
        searchPattern: 'needle',
        replacement: 'pin',
        dryRun: true,
        maxFiles: 1,
      });
      assert.match(result.text ?? '', /hit the maxFiles limit; later files were not scanned./u);
      assert.ok((result.text ?? '').includes('// Raise maxFiles to reach them.'));
    });

    it('a named file stops at an explicit maxMatches mid-file', async () => {
      const file = await writeTestFile(root, 'replace_named_cap/a.txt', 'x x x x\n');
      const result = await replace({
        path: file,
        searchPattern: 'x',
        replacement: 'y',
        maxMatches: 2,
      });
      assert.strictEqual(result.structured.totalMatches, 2);
      assert.strictEqual(result.structured.stoppedReason, 'maxMatches');
      assert.strictEqual(await readFile(file, 'utf8'), 'y y x x\n');
      assert.match(result.text ?? '', /hit the maxMatches limit; later matches were not replaced/u);
      // The literal matcher honors the same cap.
      const literal = await writeTestFile(root, 'replace_named_cap/b.txt', 'x x x x\n');
      const capped = await replace({
        path: literal,
        searchPattern: 'x',
        replacement: 'y',
        caseSensitive: true,
        maxMatches: 3,
      });
      assert.strictEqual(capped.structured.totalMatches, 3);
      assert.strictEqual(await readFile(literal, 'utf8'), 'y y y x\n');
    });

    it('a named file with no maxMatches replaces past the default cap', async () => {
      const file = await writeTestFile(root, 'replace_named_nocap/a.txt', 'x '.repeat(150));
      const result = await replace({
        path: file,
        searchPattern: 'x',
        replacement: 'y',
        dryRun: true,
      });
      assert.strictEqual(result.structured.totalMatches, 150);
      assert.strictEqual(result.structured.stoppedReason, undefined);
    });

    it('maxMatches is a strict bound across files in flight', async () => {
      const dir = join(root, 'replace_strict_cap');
      // More files than REPLACE_CONCURRENCY (8), so the cap would be exceeded if files ran in parallel.
      for (let i = 0; i < 10; i++) await writeTestFile(dir, `${String(i)}.txt`, 'x\n');
      const result = await replace({
        path: dir,
        searchPattern: 'x',
        replacement: 'y',
        maxMatches: 3,
      });
      assert.strictEqual(result.structured.totalMatches, 3);
      assert.strictEqual(result.structured.summary.succeeded, 3);
      assert.strictEqual(result.structured.stoppedReason, 'maxMatches');
      // Which three files are rewritten depends on readdir order, so only the count is pinned.
      let rewritten = 0;
      for (let i = 0; i < 10; i++) {
        if ((await readFile(join(dir, `${String(i)}.txt`), 'utf8')) === 'y\n') rewritten++;
      }
      assert.strictEqual(rewritten, 3);
    });

    it('a maxMatches dry run previews exactly what the live run writes', async () => {
      const file = await writeTestFile(root, 'replace_preview_cap/a.txt', 'x x x x\n');
      const args = { path: file, searchPattern: 'x', replacement: 'y', maxMatches: 2 };
      const dry = await replace({ ...args, dryRun: true });
      assert.match(dry.text ?? '', /^\+y y x x$/mu);
      const live = await replace(args);
      assert.strictEqual(dry.structured.totalMatches, 2);
      assert.strictEqual(live.structured.totalMatches, 2);
      assert.strictEqual(await readFile(file, 'utf8'), 'y y x x\n');
    });

    it('maxMatches on the regex path stops at the cap mid-file', async () => {
      const file = await writeTestFile(root, 'replace_regex_cap/a.txt', 'x x x x\n');
      const result = await replace({
        path: file,
        searchPattern: 'x',
        replacement: 'y',
        isRegex: true,
        maxMatches: 2,
      });
      assert.strictEqual(result.structured.stoppedReason, 'maxMatches');
      assert.strictEqual(await readFile(file, 'utf8'), 'y y x x\n');
    });

    it('refuses the removed maxResults, so a caller cannot lose its cap silently', async () => {
      const issues = await schemaIssues(
        replace({
          path: root,
          searchPattern: 'x',
          replacement: 'y',
          dryRun: true,
          maxResults: 1,
        } as ReplaceArgs),
      );
      assert.ok(
        issues.some((issue) => issue.includes('maxResults')),
        issues.join('; '),
      );
    });

    // replace_text authors its own text, so the structured half ships under
    // `_meta`, which a client like Claude Code never shows the model.
    it('puts the preview diff and the stop reason in the text', async () => {
      // More files than replace_text dispatches at once, so a finished file
      // trips maxMatches=1 before the sweep ends.
      for (let i = 0; i < 10; i++) await writeTestFile(root, `preview/${String(i)}.txt`, 'alpha\n');
      const result = await replace({
        path: join(root, 'preview'),
        searchPattern: 'alpha',
        replacement: 'ALPHA',
        dryRun: true,
        maxMatches: 1,
      });
      const text = result.text ?? '';
      assert.match(text, /^\+ALPHA$/mu);
      assert.ok(text.includes('// scan stopped early: hit the maxMatches limit;'), text);
      assert.strictEqual(result.structured.stoppedReason, 'maxMatches');
    });
  });

  // RE2 reports offsets in code points; JS strings index in UTF-16 code units,
  // so every astral character earlier in the file used to shift the splice by
  // one and cut into surrounding text.
  it('splices correctly past astral characters', async () => {
    const prefix = '# T\n\n> 🟢 a 🔺 b 📅 c\n\n';
    const file = await writeTestFile(root, 'emoji/rep.md', `${prefix}Line with ALPHA and more.\n`);
    for (const args of [
      { caseSensitive: false, isRegex: false },
      { caseSensitive: true, isRegex: false },
      { caseSensitive: true, isRegex: true },
      { caseSensitive: false, isRegex: false, wholeWord: true },
    ]) {
      await writeFile(file, `${prefix}Line with ALPHA and more.\n`);
      const result = await replace({
        path: file,
        searchPattern: 'ALPHA',
        replacement: 'BETA',
        ...args,
      });
      assert.notStrictEqual(result.isError, true);
      assert.strictEqual(
        await readFile(file, 'utf-8'),
        `${prefix}Line with BETA and more.\n`,
        `replace_text with ${JSON.stringify(args)}`,
      );
    }
  });

  describe('wholeWord', () => {
    const cases = async (
      name: string,
      list: {
        searchPattern: string;
        replacement?: string;
        before: string;
        after: string;
        matches: number;
      }[],
      extra: Partial<ReplaceArgs>,
    ) => {
      const file = await writeTestFile(root, `${name}/a.txt`, '');
      for (const c of list) {
        await writeFile(file, c.before);
        const result = await replace({
          path: file,
          searchPattern: c.searchPattern,
          replacement: c.replacement ?? 'X',
          wholeWord: true,
          ...extra,
        });
        assert.notStrictEqual(result.isError, true, c.before);
        assert.strictEqual(await readFile(file, 'utf-8'), c.after, c.before);
        assert.strictEqual(result.structured.totalMatches, c.matches, c.before);
      }
    };

    // RE2's \b is ASCII-only: it saw no boundary around "é"/"ü" and none at a
    // punctuation edge, so wholeWord matched inside words and skipped real ones.
    it('treats non-ASCII letters and punctuation edges as word boundaries', async () => {
      await cases(
        'whole_word_unicode',
        [
          {
            searchPattern: 'café',
            before: 'café cafés xcafé\n',
            after: 'X cafés xcafé\n',
            matches: 1,
          },
          {
            searchPattern: 'über',
            before: 'über Über xüber über_\n',
            after: 'X X xüber über_\n',
            matches: 2,
          },
          {
            searchPattern: '-x',
            replacement: 'Y',
            before: '-x a-x a -x\n',
            after: 'Y a-x a Y\n',
            matches: 2,
          },
          // Adjacent words share one separator: every one still matches.
          { searchPattern: 'a', replacement: 'b', before: 'a a a\n', after: 'b b b\n', matches: 3 },
          // A combining mark is part of the word it follows.
          {
            searchPattern: 'x',
            replacement: 'Y',
            before: 'x\u0301 x\n',
            after: 'x\u0301 Y\n',
            matches: 1,
          },
          // An astral non-letter is a boundary on either side.
          {
            searchPattern: 'über',
            before: '😀über über😀 ü\n',
            after: '😀X X😀 ü\n',
            matches: 2,
          },
        ],
        { caseSensitive: false },
      );
    });

    it('with isRegex keeps the caller capture groups numbered from 1', async () => {
      const file = await writeTestFile(root, 'whole_word_groups/a.txt', 'ab xab ab\n');
      const result = await replace({
        path: file,
        searchPattern: '(a)(b)',
        replacement: '$2$1[$&]',
        isRegex: true,
        caseSensitive: true,
        wholeWord: true,
      });
      assert.notStrictEqual(result.isError, true);
      assert.strictEqual(await readFile(file, 'utf-8'), 'ba[ab] xab ba[ab]\n');
    });

    it('lets the boundary pick the regex alternative', async () => {
      await cases(
        'whole_word_alt',
        [
          // RE2 must not stop at the first alternative that the boundary rejects.
          { searchPattern: 'foo|foobar', before: 'foobar foo\n', after: 'X X\n', matches: 2 },
          { searchPattern: 'a+?', before: 'aaa b\n', after: 'X b\n', matches: 1 },
          // A match's trailing character is the next match's leading one.
          { searchPattern: 'aa', before: 'aaa aa\n', after: 'aaa X\n', matches: 1 },
          { searchPattern: 'a', before: 'a a a\n', after: 'X X X\n', matches: 3 },
        ],
        { isRegex: true, caseSensitive: true },
      );
    });

    it('lets a needle trailing non-word char lead the next match', async () => {
      await cases(
        'whole_word_trail',
        [
          // The needle's final '-' is the next match's leading boundary.
          { searchPattern: '-x-', before: '-x--x-\n', after: 'XX\n', matches: 2 },
          // A one-char needle at text start: no progress is possible, so it must terminate.
          { searchPattern: '-', before: '-\n', after: 'X\n', matches: 1 },
          // A match at text start leads the next one (#158).
          { searchPattern: '-', before: '--\n', after: 'XX\n', matches: 2 },
          { searchPattern: '-', before: '---\n', after: 'XXX\n', matches: 3 },
          { searchPattern: '-', before: 'a - -- b\n', after: 'a X XX b\n', matches: 3 },
        ],
        { caseSensitive: true },
      );
    });

    it('maxMatches stops mid-run with its reason', async () => {
      const file = await writeTestFile(root, 'whole_word_max/a.txt', 'aa a a\n');
      const result = await replace({
        path: file,
        searchPattern: 'a',
        replacement: 'X',
        caseSensitive: true,
        wholeWord: true,
        maxMatches: 1,
      });
      assert.notStrictEqual(result.isError, true);
      assert.strictEqual(result.structured.stoppedReason, 'maxMatches');
      assert.strictEqual(await readFile(file, 'utf-8'), 'aa X a\n');
    });
  });

  it('regex anchors match at every line, like search_text', async () => {
    const file = await writeTestFile(root, 'anchors/a.txt', '');
    const cases: {
      searchPattern: string;
      replacement?: string;
      extra?: Partial<ReplaceArgs>;
      before: string;
      after: string;
      matches: number;
    }[] = [
      { searchPattern: '^foo', before: 'foo\nfoo\nfoo\n', after: 'X\nX\nX\n', matches: 3 },
      { searchPattern: 'foo$', before: 'foo\nfoo\nfoo\n', after: 'X\nX\nX\n', matches: 3 },
      {
        searchPattern: '^foo',
        extra: { wholeWord: true },
        before: 'foo bar\nfoo\n',
        after: 'X bar\nX\n',
        matches: 2,
      },
      {
        searchPattern: 'foo$',
        extra: { wholeWord: true },
        before: 'bar foo\nfoo\n',
        after: 'bar X\nX\n',
        matches: 2,
      },
      // \A still anchors to the whole file, not to a line.
      { searchPattern: '\\Afoo', before: 'foo\nfoo\n', after: 'X\nfoo\n', matches: 1 },
      // CRLF: ^ matches after \n; $ needs the (\r?) to also see the \r.
      { searchPattern: '^foo', before: 'foo\r\nfoo\r\n', after: 'X\r\nX\r\n', matches: 2 },
      {
        searchPattern: 'foo(\\r?)$',
        replacement: 'X$1',
        before: 'foo\r\nfoo\r\n',
        after: 'X\r\nX\r\n',
        matches: 2,
      },
      // A pattern spanning lines still matches across the newline.
      { searchPattern: 'one\\ntwo', before: 'one\ntwo\n', after: 'X\n', matches: 1 },
    ];
    for (const c of cases) {
      await writeFile(file, c.before);
      const result = await replace({
        path: file,
        searchPattern: c.searchPattern,
        replacement: c.replacement ?? 'X',
        isRegex: true,
        caseSensitive: true,
        ...c.extra,
      });
      assert.notStrictEqual(result.isError, true, c.before);
      assert.strictEqual(await readFile(file, 'utf-8'), c.after, c.before);
      assert.strictEqual(result.structured.totalMatches, c.matches, c.before);
    }
  });

  it('ignores a UTF-8 BOM when matching line 1, and keeps the mark in the file', async () => {
    const file = await writeTestFile(root, 'bom/a.txt', '');
    const cases: {
      searchPattern: string;
      extra?: Partial<ReplaceArgs>;
      before: string;
      after: string;
      matches: number;
    }[] = [
      {
        searchPattern: '^using',
        extra: { isRegex: true },
        before: '\uFEFFusing A;\nusing B;\n',
        after: '\uFEFFX A;\nX B;\n',
        matches: 2,
      },
      // A literal never saw the mark as text, and must still keep it.
      {
        searchPattern: 'using',
        before: '\uFEFFusing A;\nusing B;\n',
        after: '\uFEFFX A;\nX B;\n',
        matches: 2,
      },
      {
        searchPattern: '^foo',
        extra: { isRegex: true },
        before: '\uFEFFfoo\nbar\n',
        after: '\uFEFFX\nbar\n',
        matches: 1,
      },
    ];
    for (const c of cases) {
      await writeFile(file, c.before);
      const result = await replace({
        path: file,
        searchPattern: c.searchPattern,
        replacement: 'X',
        caseSensitive: true,
        ...c.extra,
      });
      assert.notStrictEqual(result.isError, true, c.before);
      assert.strictEqual(result.structured.totalMatches, c.matches, c.before);
      assert.strictEqual(await readFile(file, 'utf-8'), c.after, c.before);
    }
    // A dry run previews the same matches and never writes the mark off.
    await writeFile(file, '\uFEFFusing A;\nusing B;\n');
    const dry = await replace({
      path: file,
      searchPattern: '^using',
      replacement: 'X',
      caseSensitive: true,
      isRegex: true,
      dryRun: true,
    });
    assert.notStrictEqual(dry.isError, true);
    assert.strictEqual(dry.structured.totalMatches, 2);
    assert.strictEqual(await readFile(file, 'utf-8'), '\uFEFFusing A;\nusing B;\n');
  });

  it('explains a zero-match result in the text (#55)', async () => {
    const dir = join(root, 'zero_hint');
    await writeTestFile(dir, 'a.ts', 'const TOKEN1 = 1;\nconst token2 = 2;\n');
    const regexLine =
      '// searchPattern was matched as literal text but looks like a regex; pass isRegex=true to match it as one.';
    const globLine =
      "// no files were searched: nothing under path matched pattern '**/*.py' after the hidden/ignored/maxDepth filters. pattern is a file-name glob; the text to find goes in searchPattern.";
    const text = async (args: Partial<ReplaceArgs> & { searchPattern: string }) =>
      (await replace({ path: dir, replacement: 'X', dryRun: true, ...args })).text ?? '';

    assert.ok((await text({ searchPattern: '\\d+' })).endsWith(`\n${regexLine}`));
    assert.ok(
      (await text({ searchPattern: 'TOKEN1', pattern: '**/*.py' })).endsWith(`\n${globLine}`),
    );
    assert.strictEqual(
      await text({ searchPattern: '\\d{9}', isRegex: true }),
      "replace_text: '\\d{9}' [dry run] · 0 match(es) in 0 file(s)",
    );
    await writeFile(join(dir, 'b.bin'), Buffer.from([0, 0x61, 0x7c, 0x62, 0]));
    assert.strictEqual(
      await text({ searchPattern: 'a|b' }),
      "replace_text: 'a|b' [dry run] · 0 match(es) in 0 file(s)\n// skipped 1 binary file; results may be incomplete.",
    );
  });

  describe('timeouts', () => {
    it('a live timeout never writes a partially spliced file', { timeout: 5000 }, async () => {
      const file = join(root, 'dense-replace.txt');
      const original = 'a'.repeat(200_000) + '\n';
      await writeFile(file, original);
      const controller = new AbortController();
      setTimeout(() => controller.abort(timeout()), 100);
      const result = await replace(
        { path: file, searchPattern: 'a', replacement: 'b', isRegex: true, caseSensitive: true },
        { signal: controller.signal },
      );
      assert.strictEqual(result.structured.stoppedReason, 'timeout');
      assert.strictEqual(result.structured.summary.failed, 0);
      assert.notStrictEqual(result.isError, true);
      assert.strictEqual(await readFile(file, 'utf-8'), original);
    });

    for (const dryRun of [false, true]) {
      it(
        dryRun
          ? 'a dry timeout does not claim rewritten files'
          : 'a live timeout names the files it already rewrote',
        { timeout: 10000 },
        async (t) => {
          const dir = join(root, dryRun ? 'rt-timeout-dry' : 'rt-timeout-live');
          const names = Array.from({ length: 40 }, (_, i) => `f${String(i).padStart(2, '0')}.txt`);
          for (const n of names) await writeTestFile(dir, n, 'foo\n');
          const controller = new AbortController();
          const realWrite = fs.writeFile.bind(fs);
          t.mock.method(
            fs,
            'writeFile',
            async (...a: Parameters<GuardedFileSystem['writeFile']>) => {
              const out = await realWrite(...a);
              controller.abort(timeout());
              return out;
            },
          );
          if (dryRun) controller.abort(timeout());
          const result = await replace(
            { path: dir, searchPattern: 'foo', replacement: 'foobar', dryRun },
            { signal: controller.signal },
          );
          const text = result.text ?? '';
          assert.strictEqual(result.structured.stoppedReason, 'timeout');
          assert.strictEqual(result.structured.summary.failed, 0);
          assert.notStrictEqual(result.isError, true);
          let written = 0;
          for (const n of names) {
            if ((await readFile(join(dir, n), 'utf-8')) === 'foobar\n') written++;
          }
          if (dryRun) {
            assert.doesNotMatch(text, /already rewritten/u);
            assert.doesNotMatch(text, /Raise timeout/u);
            assert.strictEqual(text.match(/scan stopped early/gu)?.length, 1);
            assert.strictEqual(written, 0);
            return;
          }
          assert.match(text, /file\(s\) were already rewritten and stay changed/u);
          assert.ok(written >= 1 && written < 40, `written=${String(written)}`);
          assert.strictEqual(
            Number(/(\d+) file\(s\) were already rewritten/u.exec(text)?.[1]),
            written,
          );
        },
      );
    }
  });

  describe('a run stopped early', () => {
    const makeFoos = async (dir: string, count: number) => {
      for (let i = 0; i < count; i++) {
        await writeTestFile(dir, `f${String(i).padStart(2, '0')}.txt`, 'foo\n'.repeat(10));
      }
    };

    it('warns after the default match cap', async () => {
      const dir = join(root, 'stopped-default-cap');
      await makeFoos(dir, 30);
      const result = await replace({ path: dir, searchPattern: 'foo', replacement: 'foobar' });
      assert.strictEqual(result.structured.stoppedReason, 'maxMatches');
      assert.match(result.text ?? '', /already rewritten/u);
      assert.match(result.text ?? '', /applies it to them again/u);
    });

    it('warns after maxFiles', async () => {
      const dir = join(root, 'stopped-max-files');
      await makeFoos(dir, 2);
      const result = await replace({
        path: dir,
        searchPattern: 'foo',
        replacement: 'foobar',
        maxFiles: 1,
      });
      assert.strictEqual(result.structured.stoppedReason, 'maxFiles');
      assert.match(result.text ?? '', /already rewritten/u);
      assert.match(result.text ?? '', /applies it to them again/u);
    });

    it('does not warn on a dry run', async () => {
      const dir = join(root, 'stopped-dry-run');
      await makeFoos(dir, 30);
      const result = await replace({
        path: dir,
        searchPattern: 'foo',
        replacement: 'foobar',
        dryRun: true,
      });
      assert.strictEqual(result.structured.stoppedReason, 'maxMatches');
      assert.doesNotMatch(result.text ?? '', /already rewritten/u);
    });
  });

  it('a dry run previews through a held write lock; a live run waits for it', async () => {
    const file = await writeTestFile(root, 'locked.txt', 'needle\n');
    const gate = Promise.withResolvers<undefined>();
    const acquired = Promise.withResolvers<undefined>();
    const held = fs.lockForWrite(file, () => {
      acquired.resolve(undefined);
      return gate.promise;
    });
    await acquired.promise;
    const args = { path: file, searchPattern: 'needle', replacement: 'pin' };
    let live: Promise<unknown> | undefined;
    try {
      const dry = await replace({ ...args, dryRun: true });
      assert.strictEqual(dry.structured.totalMatches, 1);

      let settled = false;
      live = replace(args).finally(() => {
        settled = true;
      });
      await sleep(50);
      assert.strictEqual(settled, false, 'a live replace must wait for the lock');
      assert.strictEqual(await readFile(file, 'utf-8'), 'needle\n');
    } finally {
      gate.resolve(undefined);
      await held;
    }
    await live;
    assert.strictEqual(await readFile(file, 'utf-8'), 'pin\n');
  });
});

// One Match plan judges both tools: whatever search_text previews is exactly
// what replace_text touches.
describe('Match plan parity: search_text previews what replace_text rewrites', () => {
  let root: string;
  let fs: GuardedFileSystem;

  beforeEach(async () => {
    root = await createTestRoot();
    fs = new GuardedFileSystem(await makeGuard([root]));
  });

  afterEach(async () => {
    await cleanupTestRoot(root);
  });

  const search = (args: z.input<typeof SEARCH_TEXT.def.input>) =>
    runToolBodyResult(SEARCH_TEXT, args, { fs });
  const replace = (args: ReplaceArgs) => runToolBodyResult(REPLACE_TEXT, args, { fs });

  it('the lines search_text matches are the lines the replace preview changes, in every mode', async () => {
    const file = await writeTestFile(
      root,
      'parity/a.txt',
      'Key key KEY monkey\nkey-chain key_x\n\u212Aey é key\n',
    );
    for (const mode of [
      { caseSensitive: false, isRegex: false },
      { caseSensitive: true, isRegex: false },
      { caseSensitive: true, isRegex: true },
    ]) {
      const searched = await search({ path: file, searchPattern: 'key', ...mode });
      const previewed = await replace({
        path: file,
        searchPattern: 'key',
        replacement: 'K',
        dryRun: true,
        ...mode,
      });
      const removed = (previewed.structured.diff ?? '')
        .split('\n')
        .filter((line) => line.startsWith('-') && !line.startsWith('---'))
        .map((line) => line.slice(1));
      assert.ok(removed.length > 0, JSON.stringify(mode));
      assert.deepStrictEqual(
        removed,
        searched.structured.matches.map((match) => match.content),
        JSON.stringify(mode),
      );
    }
  });

  // The case-sensitive literal fast path obeys the same RE2 bail as search's
  // literal matcher: a needle containing U+FFFD, or a lone surrogate, is handed
  // to RE2 instead of a raw-byte hunt.
  it('BAIL-001: a lone-surrogate needle reports no matches, agreeing with search_text', async () => {
    // Literal U+FFFD in the file encodes as the same EF BF BD bytes a lone
    // surrogate encodes to, so the raw-byte hunt claims the file while the
    // replace pass over decoded text finds zero.
    const file = await writeTestFile(root, 'surrogate.txt', 'a\uFFFDb\n');
    const needle = '\uD800';
    const args = { path: file, searchPattern: needle, caseSensitive: true, isRegex: false };

    const searched = await search(args);
    assert.strictEqual(searched.structured.totalMatches, 0);
    const replaced = await replace({ ...args, replacement: 'X' });
    assert.notStrictEqual(replaced.isError, true);
    assert.strictEqual(replaced.structured.totalMatches, 0);
    assert.strictEqual(await readFile(file, 'utf-8'), 'a\uFFFDb\n', 'file is untouched');
  });

  it('BAIL-002: a lone-surrogate needle over a buffer past RE2 input refuses TOO_LARGE', async () => {
    // Over 4 MiB but under the default 10 MiB file limit: RE2 mode owns the
    // needle and its size guard refuses, as any regex replace does.
    const file = join(root, 'oversize.txt');
    const head = 'a\uFFFDb\n';
    await writeFile(file, head + 'x'.repeat(5 * MIB - Buffer.byteLength(head)));

    const replaced = await replace({
      path: file,
      searchPattern: '\uD800',
      replacement: 'X',
      caseSensitive: true,
      isRegex: false,
    });
    assert.strictEqual(replaced.isError, true, 'the RE2 size guard must refuse this needle');
    const row = replaced.structured.results[0] as Row | undefined;
    assert.strictEqual(row?.error?.code, 'TOO_LARGE');
    assert.strictEqual(
      (await readFile(file, 'utf-8')).slice(0, head.length),
      head,
      'file is untouched',
    );
  });

  it('BAIL-003: a U+FFFD needle still transforms a decodable file', async () => {
    const file = await writeTestFile(root, 'replacement.txt', 'a\uFFFDb\n');
    const replaced = await replace({
      path: file,
      searchPattern: '\uFFFD',
      replacement: 'X',
      caseSensitive: true,
      isRegex: false,
    });
    assert.notStrictEqual(replaced.isError, true);
    assert.strictEqual(await readFile(file, 'utf-8'), 'aXb\n');
  });
});
