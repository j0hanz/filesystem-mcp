import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

interface RegistryArgument {
  type: string;
  name?: string;
  value?: string;
  valueHint?: string;
}

describe('registry manifest', () => {
  const manifest = JSON.parse(readFileSync(new URL('../server.json', import.meta.url), 'utf8')) as {
    packages: { runtimeArguments?: RegistryArgument[]; packageArguments?: RegistryArgument[] }[];
  };

  it('REG-001: a read-only mount comes with --read-only', () => {
    const oci = manifest.packages.find((p) => p.runtimeArguments);
    assert.ok(oci);
    const mount = oci.runtimeArguments?.find((a) => a.name === '-v');
    assert.match(mount?.value ?? '', /:ro$/);
    const args = oci.packageArguments ?? [];
    // Positional with a fixed value: the schema lets a client render a named boolean as
    // `--read-only=true`, which the server refuses at startup.
    const flag = args.findIndex((a) => a.type === 'positional' && a.value === '--read-only');
    assert.notStrictEqual(flag, -1);
    // Flags come before the positional folder, as in the README's Docker example.
    assert.ok(flag < args.findIndex((a) => a.valueHint === '/workspace'));
  });
});
