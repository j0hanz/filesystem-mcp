import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { MIB } from '../src/core/util.ts';
import {
  cleanupTestRoot,
  createTestClientPair,
  createTestRoot,
  firstTextBlock,
  writeTestFile,
  type TestClientContext,
} from './helpers.ts';

// The case-sensitive literal fast path must obey the same RE2 bail as
// search's literal factory (createLiteralMatcher, search.ts:146-148): a
// needle containing U+FFFD, or a lone surrogate, is handed to RE2 instead of
// a raw-byte hunt. On decodable files in range the verdicts do not change
// (BAIL-001, BAIL-003 are guards); the one wire-visible change is the
// accepted alignment with regex mode — a buffer over RE2's input bound
// becomes TOO_LARGE instead of a silent no-match (BAIL-002).
describe('replace_text case-sensitive literal RE2 bail', { concurrency: false }, () => {
  let root: string;
  let ctx: TestClientContext;

  before(async () => {
    root = await createTestRoot();
    ctx = await createTestClientPair([root]);
  });

  after(async () => {
    await ctx.close();
    await cleanupTestRoot(root);
  });

  it('BAIL-001: a lone-surrogate needle reports no matches, agreeing with search_text', async () => {
    // Literal U+FFFD in the file encodes as the same EF BF BD bytes a lone
    // surrogate encodes to, so the raw-byte hunt claims the file while the
    // replace pass over decoded text finds zero — but a zero-match entry is
    // unreported, so the visible verdict must equal search_text's.
    const file = await writeTestFile(root, 'surrogate.txt', 'a�b\n');
    const needle = '\uD800';

    const searched = await ctx.client.callTool({
      name: 'search_text',
      arguments: { path: file, searchPattern: needle, caseSensitive: true, isRegex: false },
    });
    assert.notStrictEqual(searched.isError, true);
    assert.doesNotMatch(firstTextBlock(searched).text ?? '', /surrogate\.txt/);

    const replaced = await ctx.client.callTool({
      name: 'replace_text',
      arguments: {
        path: file,
        searchPattern: needle,
        replacement: 'X',
        caseSensitive: true,
        isRegex: false,
      },
    });
    assert.notStrictEqual(replaced.isError, true);
    assert.strictEqual(await readFile(file, 'utf-8'), 'a�b\n', 'file is untouched');
  });

  it('BAIL-002: a lone-surrogate needle over a buffer past RE2 input refuses TOO_LARGE', async () => {
    // Over 4 MiB but under the default 10 MiB file limit: today the byte hunt
    // claims the file and reports a silent no-match; with the bail, RE2 mode
    // owns the needle and its size guard refuses, as any regex replace does.
    const file = join(root, 'oversize.txt');
    const head = 'a�b\n';
    await writeFile(file, head + 'x'.repeat(5 * MIB - Buffer.byteLength(head)));

    const replaced = await ctx.client.callTool({
      name: 'replace_text',
      arguments: {
        path: file,
        searchPattern: '\uD800',
        replacement: 'X',
        caseSensitive: true,
        isRegex: false,
      },
    });
    assert.strictEqual(replaced.isError, true, 'the RE2 size guard must refuse this needle');
    assert.match(firstTextBlock(replaced).text ?? '', /TOO_LARGE/);
    assert.strictEqual(
      (await readFile(file, 'utf-8')).slice(0, head.length),
      head,
      'file is untouched',
    );
  });

  it('BAIL-003: a U+FFFD needle still transforms a decodable file', async () => {
    // The bail must not break the common case: a needle of U+FFFD routes to
    // RE2 and matches the decoded text exactly as the byte hunt did.
    const file = await writeTestFile(root, 'replacement.txt', 'a�b\n');
    const replaced = await ctx.client.callTool({
      name: 'replace_text',
      arguments: {
        path: file,
        searchPattern: '�',
        replacement: 'X',
        caseSensitive: true,
        isRegex: false,
      },
    });
    assert.notStrictEqual(replaced.isError, true);
    assert.strictEqual(await readFile(file, 'utf-8'), 'aXb\n');
  });
});
