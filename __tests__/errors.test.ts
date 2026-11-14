import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  classifyCauseChain,
  DELETE_ERRNOS,
  ErrorCode,
  FsError,
  isSkippable,
  isSkippableErrno,
  Problem,
  rethrowIfAborted,
} from '../src/core/errors.ts';

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
  it('classifies Node AbortError wrapping a TimeoutError cause as TIMEOUT, not CANCELLED', () => {
    const timeoutCause = new DOMException(
      'The operation was aborted due to timeout',
      'TimeoutError',
    );
    const abortErr = Object.assign(
      new Error('The operation was aborted', { cause: timeoutCause }),
      {
        name: 'AbortError',
        code: 'ABORT_ERR',
      },
    );
    const classified = classifyCauseChain(abortErr);
    assert.strictEqual(classified.code, ErrorCode.TIMEOUT);
  });
  it('rethrowIfAborted rethrows TimeoutError, FsError(TIMEOUT), and AbortError wrapping TimeoutError', () => {
    const timeoutDom = new DOMException('timed out', 'TimeoutError');
    assert.throws(
      () => rethrowIfAborted(timeoutDom),
      (err) => err === timeoutDom,
    );

    const fsTimeout = new FsError(ErrorCode.TIMEOUT, 'timed out');
    assert.throws(
      () => rethrowIfAborted(fsTimeout),
      (err) => err === fsTimeout,
    );

    const wrapped = Object.assign(new Error('aborted', { cause: timeoutDom }), {
      name: 'AbortError',
      code: 'ABORT_ERR',
    });
    assert.throws(
      () => rethrowIfAborted(wrapped),
      (err) => err === wrapped,
    );
  });
});

describe('isSkippableErrno', () => {
  it('accepts exactly SKIPPABLE_ERRNOS members that are Node errors', async () => {
    assert.ok(isSkippableErrno(errnoError('ENOENT')));
    assert.ok(isSkippableErrno(errnoError('EACCES')));
    assert.ok(isSkippableErrno(errnoError('ELOOP')));
    // EPERM maps to PERMISSION_DENIED, which SKIPPABLE_FS_CODES treats as
    // skippable; the errno set is derived from that map, so EPERM is too.
    assert.ok(isSkippableErrno(errnoError('EPERM')));
    assert.ok(!isSkippableErrno(errnoError('ENOTDIR')));
    assert.ok(!isSkippableErrno(new Error('no code')));
    assert.ok(!isSkippableErrno('ENOENT'));
  });
});

describe('isSkippable', () => {
  it('reads an FsError by its code and anything else by its errno', async () => {
    assert.ok(isSkippable(new FsError(ErrorCode.ACCESS_DENIED, 'no')));
    assert.ok(isSkippable(errnoError('EPERM')));
    assert.ok(!isSkippable(new FsError(ErrorCode.BINARY_FILE, 'bin')));
    assert.ok(!isSkippable(errnoError('ENOTDIR')));
  });
});

describe('Problem.fromUnknown with errno rows', () => {
  it("applies delete's rows over the shared map, and only to errnos", async () => {
    const notEmpty = Problem.fromUnknown(
      errnoError('ENOTEMPTY'),
      ErrorCode.UNKNOWN,
      '/d',
      DELETE_ERRNOS,
    );
    assert.strictEqual(notEmpty.code, ErrorCode.INVALID_INPUT);
    assert.strictEqual(notEmpty.message, 'Directory not empty. Set recursive: true.');
    assert.strictEqual(notEmpty.path, '/d');
    const missing = Problem.fromUnknown(
      errnoError('ENOENT'),
      ErrorCode.UNKNOWN,
      '/m',
      DELETE_ERRNOS,
    );
    assert.strictEqual(missing.code, ErrorCode.NOT_FOUND);
    assert.strictEqual(missing.message, 'Path not found');
    assert.ok(missing.suggestion);
    // Without rows the shared map answers.
    assert.strictEqual(
      Problem.fromUnknown(errnoError('ENOTEMPTY'), ErrorCode.UNKNOWN).code,
      ErrorCode.NOT_DIRECTORY,
    );
    // A thrown FsError keeps its own reading.
    const own = new FsError(ErrorCode.NOT_FOUND, 'gone', '/g');
    assert.strictEqual(
      Problem.fromUnknown(own, ErrorCode.UNKNOWN, '/g', DELETE_ERRNOS).message,
      'gone',
    );
  });

  it('keeps IO_ERROR for a real I/O failure instead of the default code', () => {
    const busy = Problem.fromUnknown(errnoError('EBUSY'), ErrorCode.NOT_FILE, '/f');
    assert.strictEqual(busy.code, ErrorCode.IO_ERROR);
    assert.doesNotMatch(busy.suggestion ?? '', /directory/);
    assert.strictEqual(
      Problem.fromUnknown(errnoError('EIO'), ErrorCode.NOT_FOUND).code,
      ErrorCode.IO_ERROR,
    );
  });
  it('still gives an unclassified error the default code', () => {
    assert.strictEqual(Problem.fromUnknown('nope', ErrorCode.NOT_FILE).code, ErrorCode.NOT_FILE);
  });
});
