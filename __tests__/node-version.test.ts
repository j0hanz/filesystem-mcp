import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { checkNodeVersion } from '../src/node-version.ts';

describe('checkNodeVersion', () => {
  it('NODEVER-001: passes the supported line and newer ones silently', () => {
    assert.deepStrictEqual(checkNodeVersion('v24.0.0'), {});
    assert.deepStrictEqual(checkNodeVersion('v24.22.0'), {});
    assert.deepStrictEqual(checkNodeVersion('v26.1.0'), {});
  });

  // Node 22 loads the server and a smoke run passes, so refusing it would break
  // setups that work today; it only gets told it is untested.
  it('NODEVER-002: warns on Node 22 and 23 but lets the server start', () => {
    for (const version of ['v22.0.0', 'v22.22.0', 'v23.11.1']) {
      const verdict = checkNodeVersion(version);
      assert.strictEqual(verdict.fatal, undefined, version);
      assert.match(verdict.warning ?? '', /supports Node\.js 24 or later/u);
      assert.ok(verdict.warning?.includes(version), verdict.warning);
    }
  });

  // Older lines fail while the modules link (no fs.promises.glob), so the
  // entry must refuse them with a message that names the fix.
  it('NODEVER-003: refuses Node 21 and older with the version it needs', () => {
    for (const version of ['v21.7.3', 'v20.20.0', 'v18.20.4']) {
      const verdict = checkNodeVersion(version);
      assert.strictEqual(verdict.warning, undefined, version);
      assert.match(verdict.fatal ?? '', /needs Node\.js 24 or later; this is Node\.js v\d/u);
      assert.ok(verdict.fatal?.includes(version), verdict.fatal);
    }
  });

  it('NODEVER-004: does not refuse a version it cannot parse', () => {
    assert.deepStrictEqual(checkNodeVersion(''), {});
    assert.deepStrictEqual(checkNodeVersion('vNext'), {});
  });
});
