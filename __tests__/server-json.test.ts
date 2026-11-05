import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

interface RegistryArgument {
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
    const names = (oci.packageArguments ?? []).map((a) => a.name ?? a.valueHint);
    assert.ok(names.includes('--read-only'));
    // Flags come before the positional folder, as in the README's Docker example.
    assert.ok(names.indexOf('--read-only') < names.indexOf('/workspace'));
  });
});
