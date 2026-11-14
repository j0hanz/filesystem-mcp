import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { closestLines } from '../src/core/closest-lines.ts';

describe('closestLines', () => {
  const file =
    ['function a() {', '  return 1;', '}', '', 'function b() {', '  return  2;', '}'].join('\n') +
    '\n';

  it('quotes the closest lines with numbers and two lines of context', () => {
    const out = closestLines(file, 'function b() {\n  return 2;\n}');
    assert.match(out, /Closest text in the file \(lines 3-7 of 7\):/);
    assert.match(out, /^5: function b\(\) \{$/m);
    assert.match(out, /^6: {3}return {2}2;$/m);
  });

  it('names the first differing line with both sides quoted', () => {
    const out = closestLines(file, 'function b() {\n  return 2;\n}');
    assert.match(out, /First difference, oldText line 2 against file line 6:/);
    assert.ok(out.includes('  oldText: "  return 2;"'));
    assert.ok(out.includes('  file:    "  return  2;"'));
  });

  it('says an empty file is empty', () => {
    assert.strictEqual(closestLines('', 'x'), 'The file is empty.');
  });

  it('says when nothing resembles oldText', () => {
    assert.match(closestLines('aaaa\nbbbb\n', 'zzzz'), /No line of the file resembles oldText/);
  });

  it('says when oldText runs past the end of the file', () => {
    const out = closestLines('one\ntwo\n', 'two\nthree');
    assert.match(
      out,
      /oldText line 2 \("three"\) runs past the end of the file, which ends at line 2/,
    );
  });

  it('cuts a long line at 500 characters', () => {
    const out = closestLines(`${'ab'.repeat(5000)}\n`, 'ab'.repeat(40) + 'x');
    assert.match(out, /\[\.\.\. cut: the line has 10000 characters\]/);
    assert.ok(out.length < 20_000);
  });

  it('quotes at most 30 lines', () => {
    const big = Array.from({ length: 100 }, (_, i) => `line ${String(i)}`).join('\n') + '\n';
    const old = Array.from({ length: 60 }, (_, i) => `line ${String(i)}x`).join('\n');
    const quoted = closestLines(big, old)
      .split('\n')
      .filter((l) => /^\d+: /.test(l));
    assert.strictEqual(quoted.length, 30);
  });

  it('skips the search past the work limit', () => {
    const huge = 'abcdefghij\n'.repeat(200_000);
    const old = Array.from({ length: 20 }, () => 'abcdefghiX').join('\n');
    assert.match(closestLines(huge, old), /too many to search for the closest text/);
  });

  it('never splits a surrogate pair when cutting at 500 characters', () => {
    const line = `${'a'.repeat(499)}😀${'b'.repeat(20)}`;
    const out = closestLines(`${line}\n`, `${'a'.repeat(40)}x`);
    assert.strictEqual(out.isWellFormed(), true);
    assert.match(out, /\[\.\.\. cut: the line has 521 characters\]/);
  });

  it('ignores a trailing newline in oldText when checking differences at EOF', () => {
    const out = closestLines('one\ntwo\n', '  two\n');
    assert.match(out, /First difference, oldText line 1 against file line 2:/);
    assert.ok(out.includes('  oldText: "  two"'));
    assert.ok(out.includes('  file:    "two"'));
  });

  it('reports the first line whose whitespace differs when trimmed lines match', () => {
    const out = closestLines(
      'function b() {\n  return 2;\n}\n',
      'function b() {\n    return 2;\n}',
    );
    assert.match(out, /First difference, oldText line 2 against file line 2:/);
    assert.ok(out.includes('  oldText: "    return 2;"'));
    assert.ok(out.includes('  file:    "  return 2;"'));
  });

  it('does not treat blank lines as a match', () => {
    assert.match(
      closestLines('alpha\n\nbeta\n', 'zzzz\n\nwwww'),
      /No line of the file resembles oldText/,
    );
    const withBlankHeader = [
      '// header',
      '',
      '// run()',
      'const a = 1;',
      'const b = 2;',
      'const c = 3;',
      'const d = 4;',
      'const e = 5;',
      'function target() {',
      '  run();',
      '}',
    ].join('\n');
    const out = closestLines(withBlankHeader, 'function target() {\n\n  run_typo();');
    assert.match(out, /^9: function target\(\) \{$/m);
  });

  it('skips the search when the file characters alone pass the work limit', () => {
    const hugeLine = `${'abcd'.repeat(2_500_001)}\n`;
    assert.match(closestLines(hugeLine, 'xyz'), /too many to search for the closest text/);
  });

  it('bounds line bigram scoring to the first 500 characters', () => {
    const filler = ['vvvvv', 'vvvvv', 'vvvvv', 'vvvvv'];
    const earlyLine = `match_prefix_${'z'.repeat(600)}`;
    const lateLine = `${'y'.repeat(600)}match_prefix_${'q'.repeat(20)}`;
    const content = [earlyLine, ...filler, lateLine].join('\n');
    const out = closestLines(content, `match_prefix_${'q'.repeat(20)}`);
    assert.match(out, /First difference, oldText line 1 against file line 1:/);
  });
});
