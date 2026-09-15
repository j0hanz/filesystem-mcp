import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { sanitizeLogField } from '../src/core/observability.js';

describe('sanitizeLogField', () => {
  it('flattens control characters so a client value cannot forge a log line', () => {
    assert.strictEqual(sanitizeLogField('7\n[error] forged\r\n'), '7 [error] forged ');
  });

  it('caps the value length', () => {
    assert.strictEqual(sanitizeLogField('x'.repeat(500)).length, 128);
  });
});
