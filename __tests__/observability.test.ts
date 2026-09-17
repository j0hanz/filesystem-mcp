import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { sanitizeLogField } from '../src/core/observability.ts';

describe('sanitizeLogField', () => {
  it('flattens control characters so a client value cannot forge a log line', () => {
    assert.strictEqual(sanitizeLogField('7\n[error] forged\r\n'), '7 [error] forged ');
  });

  it('flattens the Unicode line and paragraph separators too', () => {
    assert.strictEqual(sanitizeLogField('a\u2028b\u2029c'), 'a b c');
  });

  it('caps the value length, or leaves it uncapped on request', () => {
    assert.strictEqual(sanitizeLogField('x'.repeat(500)).length, 128);
    assert.strictEqual(sanitizeLogField('x'.repeat(500), Infinity).length, 500);
  });
});
