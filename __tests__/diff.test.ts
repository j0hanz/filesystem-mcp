import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { diffStatsFromPatch, unifiedPatch } from '../src/core/diff.ts';

const lines = (prefix: string, n: number): string =>
  Array.from({ length: n }, (_, i) => `${prefix}${String(i)}`).join('\n') + '\n';

describe('core/diff', () => {
  it('counts added and removed lines from a patch', () => {
    const a = 'one\ntwo\nthree\n';
    const b = 'one\n2\nthree\nfour\n';
    const patch = unifiedPatch('f', a, b);
    assert.ok(patch);
    assert.deepStrictEqual(diffStatsFromPatch(patch), { linesAdded: 2, linesRemoved: 1 });
  });

  it('counts content lines that start with -- or ++ (not just the file header)', () => {
    const a = '---\ntitle: x\n---\nbody\n';
    const b = 'title: x\nbody\n++new\n';
    const patch = unifiedPatch('f', a, b);
    assert.ok(patch);
    assert.deepStrictEqual(diffStatsFromPatch(patch), { linesAdded: 1, linesRemoved: 2 });
  });

  it('gives up past the deadline instead of blocking', () => {
    const a = lines('a', 4000);
    const b = lines('b', 4000);
    assert.strictEqual(unifiedPatch('f', a, b, 1), undefined);
  });
});
