import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { ErrorCode } from '../src/core/errors.ts';
import { compileRegex, freeRegex, type Regex } from '../src/core/matcher.ts';
import { SEARCH_TEXT } from '../src/tools/index.ts';
import { cleanupTestRoot, createTestRoot, fsErrorMatcher, writeTestFile } from './helpers.ts';
import { runToolBodyResult } from './tool-harness.ts';

const LARGE_PROGRAM = '[^x]'.repeat(2500);

describe('a RE2 abort', () => {
  let root: string;
  let dir: string;
  let file: string;

  before(async () => {
    root = await createTestRoot();
    dir = `${root}/walked`;
    const body = 'abc NEEDLE\n';
    file = await writeTestFile(
      dir,
      'valid.txt',
      body.repeat(Math.floor((3.9 * 1024 * 1024) / body.length)),
    );
  });

  after(async () => {
    await cleanupTestRoot(root);
  });

  it('is reported as the engine running out of memory, not as an unreadable file', async () => {
    const live: Regex[] = [];
    await assert.rejects(
      async () => {
        for (let i = 0; i < 60; i++) live.push(compileRegex(LARGE_PROGRAM));
      },
      fsErrorMatcher(ErrorCode.TOO_LARGE, /restart/i),
    );
    for (const regex of live) freeRegex(regex);

    // The abort above leaked heap, so this valid file now aborts too.
    const walked = await runToolBodyResult(
      SEARCH_TEXT,
      { path: dir, searchPattern: 'NEE+DLE', isRegex: true },
      { roots: [root] },
    );
    assert.strictEqual(walked.structured.skippedTooLarge, 1);
    assert.strictEqual(walked.structured.skippedInaccessible, undefined);

    await assert.rejects(
      runToolBodyResult(
        SEARCH_TEXT,
        { path: file, searchPattern: 'NEE+DLE', isRegex: true },
        { roots: [root] },
      ),
      fsErrorMatcher(ErrorCode.TOO_LARGE, /restart/i),
    );
  });
});
