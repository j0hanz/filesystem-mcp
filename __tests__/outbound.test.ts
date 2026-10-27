import { ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ErrorCode, FsError } from '../src/core/errors.ts';
import {
  bytesOverMessageLimit,
  jsonByteBound,
  jsonBytesOver,
  MAX_OUTBOUND_RESULT_BYTES,
  readResultFloor,
  refuseResourceRead,
  refuseToolResult,
} from '../src/core/outbound.ts';

const MAX = MAX_OUTBOUND_RESULT_BYTES;

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

describe('Message limit', () => {
  it('bytesOverMessageLimit fits on http and unset transport', () => {
    const value = { text: 'x'.repeat(MAX) };
    assert.strictEqual(bytesOverMessageLimit('http', value), undefined);
    assert.strictEqual(bytesOverMessageLimit(undefined, value), undefined);
    assert.strictEqual(
      bytesOverMessageLimit('stdio', value),
      Buffer.byteLength(JSON.stringify(value), 'utf8'),
    );
  });

  it('bytesOverMessageLimit edge', () => {
    // `{"t":"…"}` spends 8 bytes around the string.
    const exact = { t: 'x'.repeat(MAX - 8) };
    assert.strictEqual(Buffer.byteLength(JSON.stringify(exact), 'utf8'), MAX);
    assert.strictEqual(bytesOverMessageLimit('stdio', exact), undefined);
    assert.strictEqual(bytesOverMessageLimit('stdio', { t: 'x'.repeat(MAX - 7) }), MAX + 1);
  });

  it('readResultFloor', () => {
    assert.strictEqual(readResultFloor(MAX, false), MAX);
    assert.strictEqual(readResultFloor(3, true), 4);
    assert.strictEqual(readResultFloor(4, true), 8);
  });

  it('refuseToolResult text', () => {
    const error = refuseToolResult('read', 123, 'R');
    assert.ok(error instanceof FsError);
    assert.strictEqual(error.code, ErrorCode.TOO_LARGE);
    assert.strictEqual(
      error.message,
      'read result too large to return (123 bytes once JSON-encoded, over the 10223616-byte stdio message limit).',
    );
    assert.strictEqual(error.problem.suggestion, 'R');
  });

  it('refuseResourceRead text', () => {
    const error = refuseResourceRead(5, true);
    assert.ok(ProtocolError.isInstance(error));
    assert.strictEqual(error.code, ProtocolErrorCode.InvalidParams);
    assert.match(error.message, /^Resource result too large to return \(at least 5 bytes/);
    assert.deepStrictEqual(error.data, {
      code: 'TOO_LARGE',
      suggestion: 'Read smaller slices/pages with tools, or connect over HTTP.',
    });
    assert.doesNotMatch(refuseResourceRead(5).message, /at least/);
  });
});
