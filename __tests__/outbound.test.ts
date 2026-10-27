import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { jsonByteBound, jsonBytesOver } from '../src/core/outbound.ts';

describe('encoded result size bound', () => {
  it('never undercounts what JSON.stringify writes', () => {
    const samples: unknown[] = [
      '',
      'plain ascii',
      '"\\\n\t\u0000\u001f\u007f',
      '\ud800 lone \udfff surrogates',
      // The worst cases: six bytes for every code unit.
      '\u0000\u0001\u001f'.repeat(10),
      '\udc00'.repeat(10),
      { '\u0000\u0001': '\ud800' },
      'emoji \u{1f600}, CJK 漢字, and é',
      0,
      -0,
      -1.2345678901234567e-308,
      -0.0000012345678901234567,
      123456789012345680000,
      Number.MAX_VALUE,
      Number.NaN,
      Number.NEGATIVE_INFINITY,
      true,
      false,
      null,
      [],
      {},
      [undefined, () => 1, null],
      { omitted: undefined, method: () => 1, 'k"e\ny': [1, { '': '' }] },
      { date: new Date(0), nested: [[[[]]]], buffer: Buffer.from('ab') },
    ];
    for (const value of [...samples, samples, { samples }]) {
      const actual = Buffer.byteLength(JSON.stringify(value), 'utf8');
      assert.ok(jsonByteBound(value) >= actual, `${JSON.stringify(value)}: bound under ${actual}`);
    }
  });

  it('measures exactly only what the bound cannot clear', (t) => {
    const escaped = { text: '"'.repeat(1000) };
    const actual = Buffer.byteLength(JSON.stringify(escaped), 'utf8');
    const stringify = t.mock.method(JSON, 'stringify');
    assert.strictEqual(jsonBytesOver({ text: 'x'.repeat(1000) }, 10_000), undefined);
    assert.strictEqual(stringify.mock.callCount(), 0, 'the bound cleared it unencoded');
    stringify.mock.restore();
    assert.ok(jsonByteBound(escaped) > 3000);
    assert.strictEqual(jsonBytesOver(escaped, 3000), undefined, 'over the bound, under the limit');
    assert.strictEqual(jsonBytesOver(escaped, actual - 1), actual);
  });
});
