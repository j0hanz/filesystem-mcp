import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import {
  bootHttpTest,
  cleanupTestRoot,
  createTestRoot,
  type HttpTestContext,
  TEST_API_KEY,
} from './helpers.js';
import { executeInspectorCli, inspectorSkipReason } from './inspector-harness.js';

describe(
  'Inspector CLI: Streamable HTTP Transport & Authentication',
  { skip: inspectorSkipReason() },
  () => {
    let tmpDir: string;
    let http: HttpTestContext;
    let serverUrl: string;

    before(async () => {
      tmpDir = await createTestRoot();
      http = await bootHttpTest([tmpDir]);
      serverUrl = http.base.href;
    });

    after(async () => {
      if (http) {
        await http.close();
      }
      await cleanupTestRoot(tmpDir);
    });

    it('INSP-HTTP-001: unauthenticated request exits with Code 3 (auth_required)', async () => {
      const res = await executeInspectorCli({
        method: 'tools/list',
        serverUrl,
        transport: 'http',
      });

      assert.strictEqual(
        res.exitCode,
        3,
        `Unauthenticated HTTP request should exit with code 3. Actual: ${res.exitCode}, stderr: ${res.stderr}`,
      );
    });

    it('INSP-HTTP-002: request with valid Bearer header exits with Code 0 and returns tools', async () => {
      const res = await executeInspectorCli<{
        tools?: { name: string }[];
      }>({
        method: 'tools/list',
        serverUrl,
        transport: 'http',
        headers: {
          Authorization: `Bearer ${TEST_API_KEY}`,
        },
      });

      assert.strictEqual(
        res.exitCode,
        0,
        `Authenticated HTTP request should exit with code 0. Actual: ${res.exitCode}, stderr: ${res.stderr}`,
      );
      assert.ok(Array.isArray(res.json?.tools), 'Tools should be returned');
      assert.ok(
        res.json?.tools?.some((t) => t.name === 'read'),
        'read tool should be in listing',
      );
    });
  },
);
