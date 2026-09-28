import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { ESLint } from 'eslint';

const root = fileURLToPath(new URL('..', import.meta.url));
const eslint = new ESLint({ cwd: root });

describe('registrar import boundaries', () => {
  async function restrictedImports(filePath: string, specifier: string) {
    const [result] = await eslint.lintText(
      `import * as dependency from '${specifier}';\nvoid dependency;\n`,
      { filePath },
    );
    assert.ok(result, 'the virtual fixture must be linted');
    assert.strictEqual(result.fatalErrorCount, 0);
    assert.ok(!result.messages.some((message) => message.message.startsWith('File ignored')));
    return result.messages.filter((message) => message.ruleId === 'no-restricted-imports');
  }

  const registrars = [
    { filePath: join(root, 'src', 'tools', 'read.ts'), prefix: '../', name: 'tools' },
    { filePath: join(root, 'src', 'prompts.ts'), prefix: './', name: 'prompts' },
    { filePath: join(root, 'src', 'resources.ts'), prefix: './', name: 'resources' },
  ];

  for (const { filePath, prefix, name } of registrars) {
    const cases = [
      { specifier: `${prefix}server.ts`, expected: 1 },
      { specifier: `${prefix}server.js`, expected: 1 },
      { specifier: `${prefix}core/errors.ts`, expected: 0 },
      { specifier: 'path', expected: 1 },
    ];
    for (const { specifier, expected } of cases) {
      it(`${name}: ${expected ? 'rejects' : 'permits'} ${specifier}`, async () => {
        assert.strictEqual((await restrictedImports(filePath, specifier)).length, expected);
      });
    }
  }

  it('permits the transport to import the factory', async () => {
    assert.strictEqual(
      (await restrictedImports(join(root, 'src', 'transport', 'http.ts'), '../server.ts')).length,
      0,
    );
  });
});
