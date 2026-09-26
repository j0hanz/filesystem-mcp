import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { classifyCauseChain, ErrorCode, isSkippableErrno } from '../src/core/errors.ts';

const errnoError = (code: string, path?: string): NodeJS.ErrnoException =>
  Object.assign(new Error(`${code}: boom`), path === undefined ? { code } : { code, path });

describe('classifyCauseChain', () => {
  it('an abort wins, then a timeout, then the errno', async () => {
    assert.strictEqual(
      classifyCauseChain(Object.assign(new Error('stop'), { name: 'AbortError' })).code,
      ErrorCode.CANCELLED,
    );
    assert.strictEqual(
      classifyCauseChain(Object.assign(new Error('late'), { name: 'TimeoutError' })).code,
      ErrorCode.TIMEOUT,
    );
    assert.strictEqual(classifyCauseChain(errnoError('ENOENT', '/x')).code, ErrorCode.NOT_FOUND);
    assert.strictEqual(classifyCauseChain(errnoError('ENOENT', '/x')).path, '/x');
  });
  it('an unmapped errno falls back to IO_ERROR; a non-Error is UNKNOWN', async () => {
    assert.strictEqual(classifyCauseChain(errnoError('ENODEV')).code, ErrorCode.IO_ERROR);
    assert.strictEqual(classifyCauseChain('nope').code, ErrorCode.UNKNOWN);
  });
  it('walks the cause chain', async () => {
    const wrapped = new Error('outer', {
      cause: Object.assign(new Error('stop'), { name: 'AbortError' }),
    });
    assert.strictEqual(classifyCauseChain(wrapped).code, ErrorCode.CANCELLED);
  });
});

describe('isSkippableErrno', () => {
  it('accepts exactly SKIPPABLE_ERRNOS members that are Node errors', async () => {
    assert.ok(isSkippableErrno(errnoError('ENOENT')));
    assert.ok(isSkippableErrno(errnoError('EACCES')));
    assert.ok(isSkippableErrno(errnoError('ELOOP')));
    assert.ok(!isSkippableErrno(errnoError('EPERM')));
    assert.ok(!isSkippableErrno(new Error('no code')));
    assert.ok(!isSkippableErrno('ENOENT'));
  });
});
