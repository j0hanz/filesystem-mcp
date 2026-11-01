import type { Client } from '@modelcontextprotocol/client';

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { normalizePath } from '../src/core/path-utils.ts';
import { ALL_TOOLS } from '../src/tools/index.ts';
import {
  ALL_REGISTERED_TOOL_NAMES,
  bootHttpTest,
  cleanupTestRoot,
  createStdioClient,
  createTestRoot,
  firstTextBlock,
  withEnv,
} from './helpers.ts';

type ToolResult = Awaited<ReturnType<Client['callTool']>>;
interface Harness {
  client: Client;
  close: () => Promise<void>;
}
interface Batch<T> {
  results: { path: string; value?: T; error?: { code: string } }[];
  summary: { total: number; succeeded: number; failed: number };
}
interface Written {
  path: string;
  size: number;
  resourceUri?: string;
}
type Edited = Written & { appliedEdits: number; diff?: string };
type Patched = Written & { linesAdded: number; linesRemoved: number; diff?: string };
interface Found {
  results: { path: string }[];
  totalMatches: number;
  nextCursor?: string;
}
interface Match {
  file: string;
  line: number;
  content: string;
}
interface Searched {
  matches: Match[];
  totalMatches: number;
  nextCursor?: string;
}

const TOOL_NAMES = [...ALL_REGISTERED_TOOL_NAMES].sort();
const READ_ONLY_NAMES = ALL_TOOLS.filter((tool) => tool.readOnlyHint)
  .map((tool) => tool.name)
  .sort();

// The wire metadata has no schema type; assertions at each call site validate the selected shape.
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
function metadata<T>(result: ToolResult): T {
  const value = result.structuredContent ?? result._meta;
  assert.ok(value, 'tool must publish structured metadata');
  return value as T;
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  assert.notEqual(result.isError, true, `${name}: ${JSON.stringify(result.content)}`);
  return result;
}

async function assertBytes(path: string, expected: string) {
  assert.deepEqual(await readFile(path), Buffer.from(expected), path);
}

async function finishConcurrent(operations: readonly Promise<void>[]): Promise<void> {
  // A failed assertion must not start teardown while sibling requests still write.
  const results = await Promise.allSettled(operations);
  for (const result of results) {
    if (result.status === 'rejected') throw result.reason;
  }
}

async function isolated(
  transport: 'stdio' | 'http',
  run: (client: Client, root: string, outside: string) => Promise<void>,
  readOnly = false,
) {
  const cleanEnv: Record<string, string | undefined> = Object.fromEntries(
    Object.keys(process.env)
      .filter((key) => key.startsWith('FS_'))
      .map((key) => [key, undefined]),
  );
  await withEnv(cleanEnv, async () => {
    const fixture = normalizePath(await createTestRoot());
    let harness: Harness | undefined;
    try {
      const root = join(fixture, 'workspace');
      const outside = join(fixture, 'outside.txt');
      await mkdir(root);
      await writeFile(outside, 'synthetic outside sentinel\n');
      const env = { FS_ROOT_BOUNDARY: root, FS_LOG_LEVEL: 'error', FS_RATE_LIMIT_RPM: '10000' };
      if (transport === 'stdio') {
        harness = await createStdioClient(root, env, readOnly ? ['--read-only'] : []);
      } else {
        const http = await bootHttpTest([root], env);
        try {
          const unauthenticated = await fetch(http.base);
          assert.equal(unauthenticated.status, 401, 'loopback HTTP still requires authentication');
          await unauthenticated.body?.cancel();
          harness = { client: await http.makeClient('sandbox'), close: http.close };
        } catch (error) {
          await http.close();
          throw error;
        }
      }
      await run(harness.client, root, outside);
    } finally {
      try {
        await harness?.close();
      } finally {
        await cleanupTestRoot(fixture);
      }
    }
  });
}

async function lifecycle(client: Client, root: string, outside: string) {
  const inventory = await client.listTools();
  assert.deepEqual(inventory.tools.map((tool) => tool.name).sort(), TOOL_NAMES);
  for (const tool of inventory.tools) {
    assert.equal(tool.inputSchema.type, 'object', `${tool.name} accepts object arguments`);
    assert.equal(tool.annotations?.readOnlyHint, READ_ONLY_NAMES.includes(tool.name));
  }
  assert.deepEqual(metadata(await call(client, 'list_roots', {})), {
    roots: [root],
    readOnlyDirs: [],
  });

  const path = join(root, 'project', 'notes.txt');
  const target = join(root, 'project', 'target.txt');
  const original = 'title: café\nstatus: draft\ncount: 1\n';
  const edited = original.replace('draft', 'review');
  const patched = edited.replace('count: 1', 'count: 2');
  const created = metadata<{ files: Written[] }>(
    await call(client, 'create', {
      files: [
        { path, content: original },
        { path: target, content: patched },
      ],
    }),
  );
  assert.deepEqual(
    created.files.map((file) => ({ path: file.path, size: file.size })),
    [
      { path, size: Buffer.byteLength(original) },
      { path: target, size: Buffer.byteLength(patched) },
    ],
  );
  await assertBytes(path, original);
  await assertBytes(target, patched);

  const read = await call(client, 'read', { path, includeHash: true });
  const hash = createHash('sha256').update(original).digest('hex');
  assert.equal(firstTextBlock(read).text, `${original}\n// sha256: ${hash}`);
  const readMeta = metadata<Batch<{ contentHash: string; resourceUri: string }>>(read);
  assert.equal(readMeta.results[0]?.value?.contentHash, hash);
  const uri = readMeta.results[0]?.value?.resourceUri;
  assert.ok(uri);
  const resource = await client.readResource({ uri });
  assert.equal(resource.contents.length, 1);
  const content = resource.contents[0];
  assert.ok(content && 'text' in content);
  assert.equal(content.text, original);
  const range = await call(client, 'read', { path, startLine: 2, endLine: 2 });
  assert.equal(firstTextBlock(range).text?.split('\n\n// truncated:')[0], 'status: draft');
  const continuation =
    metadata<Batch<{ continuation: { tool: string; args: Record<string, unknown> } }>>(range)
      .results[0]?.value?.continuation;
  assert.ok(continuation);
  assert.equal(continuation.tool, 'read');
  assert.deepEqual(continuation.args, { path, startLine: 3, endLine: 3 });
  assert.equal(
    firstTextBlock(await call(client, continuation.tool, continuation.args)).text,
    'count: 1',
  );

  const info = metadata<Batch<{ type: string; size: number }>>(
    await call(client, 'stat', { path }),
  );
  assert.equal(info.results[0]?.value?.type, 'file');
  assert.equal(info.results[0]?.value?.size, (await stat(path)).size);
  const listed = metadata<{ entries: { relativePath: string }[] }>(
    await call(client, 'list', { path: root, maxDepth: 2 }),
  );
  assert.deepEqual(listed.entries.map((entry) => entry.relativePath).sort(), [
    'project',
    'project/notes.txt',
    'project/target.txt',
  ]);
  const found = metadata<Found>(
    await call(client, 'find_files', { path: root, pattern: '**/*.txt' }),
  );
  assert.deepEqual(found.results, [{ path: 'project/notes.txt' }, { path: 'project/target.txt' }]);
  const searched = metadata<Searched>(
    await call(client, 'search_text', {
      path: root,
      searchPattern: 'status: draft',
      caseSensitive: true,
    }),
  );
  assert.deepEqual(
    searched.matches.map(({ file, line, content }) => ({ file, line, content })),
    [{ file: 'project/notes.txt', line: 2, content: 'status: draft' }],
  );

  const edits = [{ oldText: 'status: draft', newText: 'status: review' }];
  const preview = metadata<Batch<Edited>>(
    await call(client, 'edit', { path, edits, dryRun: true }),
  );
  assert.equal(preview.results[0]?.value?.appliedEdits, 1);
  assert.match(preview.results[0]?.value?.diff ?? '', /-status: draft\n\+status: review/);
  assert.equal(preview.results[0]?.value?.resourceUri, undefined);
  await assertBytes(path, original);
  const applied = metadata<Batch<Edited>>(await call(client, 'edit', { path, edits }));
  assert.equal(applied.results[0]?.value?.appliedEdits, 1);
  await assertBytes(path, edited);

  const diff = await call(client, 'diff', { a: path, b: target });
  assert.partialDeepStrictEqual(metadata(diff), {
    a: path,
    b: target,
    linesAdded: 1,
    linesRemoved: 1,
  });
  const unified = firstTextBlock(diff).text;
  assert.ok(unified);
  assert.match(unified, /-count: 1\n\+count: 2/);
  await assertBytes(path, edited);
  await assertBytes(target, patched);
  for (const dryRun of [true, false]) {
    const result: Patched = metadata<Patched>(
      await call(client, 'patch', { path, diff: unified, dryRun }),
    );
    assert.equal(result.linesAdded, 1);
    assert.equal(result.linesRemoved, 1);
    assert.equal(result.size, Buffer.byteLength(patched));
    await assertBytes(path, dryRun ? edited : patched);
  }

  for (const dryRun of [true, false]) {
    const replacement = metadata<
      Batch<{ matches: number }> & { totalMatches: number; diff: string }
    >(
      await call(client, 'replace_text', {
        path: join(root, 'project'),
        pattern: '*.txt',
        searchPattern: 'count: (\\d+)',
        replacement: 'total: $1',
        isRegex: true,
        dryRun,
        returnDiff: true,
      }),
    );
    assert.equal(replacement.totalMatches, 2);
    assert.deepEqual(replacement.summary, { total: 2, succeeded: 2, failed: 0 });
    assert.deepEqual(
      replacement.results.map((item) => item.value?.matches),
      [1, 1],
    );
    assert.match(replacement.diff, /-count: 2\n\+total: 2/);
    await assertBytes(path, dryRun ? patched : patched.replace('count:', 'total:'));
    await assertBytes(target, dryRun ? patched : patched.replace('count:', 'total:'));
  }

  const copy = join(root, 'copy.txt');
  const moved = join(root, 'moved.txt');
  for (const [source, destination, copyMode] of [
    [path, copy, true],
    [copy, moved, false],
  ] as const) {
    assert.partialDeepStrictEqual(
      metadata(await call(client, 'move', { moves: [{ source, destination }], copy: copyMode })),
      { moves: [{ from: source, to: destination }] },
    );
    await assertBytes(destination, patched.replace('count:', 'total:'));
  }
  await assert.rejects(stat(copy), { code: 'ENOENT' });
  await assertBytes(path, patched.replace('count:', 'total:'));
  const removed = metadata<Batch<{ deleted: boolean }>>(
    await call(client, 'delete', { paths: [moved] }),
  );
  assert.partialDeepStrictEqual(removed, {
    results: [{ path: moved, value: { deleted: true } }],
    summary: { total: 1, succeeded: 1, failed: 0 },
  });
  await assert.rejects(stat(moved), { code: 'ENOENT' });

  const missing = join(root, 'missing.txt');
  const mixed = metadata<Batch<{ size: number }>>(
    await call(client, 'stat', { paths: [path, missing] }),
  );
  assert.deepEqual(mixed.summary, { total: 2, succeeded: 1, failed: 1 });
  assert.equal(mixed.results[0]?.value?.size, (await stat(path)).size);
  assert.equal(mixed.results[1]?.path, missing);
  assert.equal(mixed.results[1]?.error?.code, 'NOT_FOUND');

  const sensitive = join(root, '.env');
  await writeFile(sensitive, 'synthetic sensitive sentinel\n');
  const partialPath = join(root, 'partial.txt');
  const partial = metadata<{
    files: Written[];
    failures: { path: string; error: { code: string } }[];
  }>(
    await call(client, 'create', {
      files: [
        { path: partialPath, content: 'partial batch success\n' },
        { path: sensitive, content: 'must not append', append: true },
      ],
    }),
  );
  assert.deepEqual(
    partial.files.map((file) => file.path),
    [partialPath],
  );
  assert.equal(partial.failures.length, 1);
  assert.equal(partial.failures[0]?.path, sensitive);
  assert.equal(partial.failures[0]?.error.code, 'ACCESS_DENIED');
  await assertBytes(partialPath, 'partial batch success\n');
  for (const denied of [outside, sensitive]) {
    const result = await client.callTool({ name: 'read', arguments: { path: denied } });
    assert.equal(result.isError, true);
    assert.equal(metadata<Batch<unknown>>(result).results[0]?.error?.code, 'ACCESS_DENIED');
    assert.doesNotMatch(JSON.stringify(result), /synthetic (outside|sensitive) sentinel/);
    const write = await client.callTool({
      name: 'create',
      arguments: { files: [{ path: denied, content: 'must not append', append: true }] },
    });
    assert.equal(write.isError, true);
    assert.equal(
      metadata<{ failures: { path: string; error: { code: string } }[] }>(write).failures[0]?.error
        .code,
      'ACCESS_DENIED',
    );
  }
  await assertBytes(outside, 'synthetic outside sentinel\n');
  await assertBytes(sensitive, 'synthetic sensitive sentinel\n');
  assert.deepEqual(metadata(await call(client, 'list_roots', {})), {
    roots: [root],
    readOnlyDirs: [],
  });
}

async function stress(client: Client, root: string) {
  const count = 24;
  const directory = join(root, 'many');
  const names = Array.from({ length: count }, (_, i) => `item-${String(i).padStart(2, '0')}.txt`);
  // Four independent requests in flight, with deterministic bytes checked before the next wave.
  for (let offset = 0; offset < count; offset += 4) {
    await finishConcurrent(
      names.slice(offset, offset + 4).map(async (name) => {
        const path = join(directory, name);
        const content = `marker ${name}\n`;
        const result = metadata<{ files: Written[] }>(
          await call(client, 'create', { files: [{ path, content }] }),
        );
        assert.equal(result.files[0]?.size, Buffer.byteLength(content));
        assert.equal(firstTextBlock(await call(client, 'read', { path })).text, content);
        await assertBytes(path, content);
      }),
    );
  }
  assert.deepEqual((await readdir(directory)).sort(), names);

  const journal = join(root, 'journal.txt');
  const appended = ['append-0\n', 'append-1\n', 'append-2\n', 'append-3\n'];
  await finishConcurrent(
    appended.map(async (content) => {
      const result = metadata<{ files: Written[] }>(
        await call(client, 'create', { files: [{ path: journal, content, append: true }] }),
      );
      assert.equal(result.files[0]?.path, journal);
    }),
  );
  assert.deepEqual(
    (await readFile(journal, 'utf8')).trimEnd().split('\n').sort(),
    appended.map((s) => s.trimEnd()),
  );

  const findArgs = { path: directory, pattern: '*.txt', maxResults: 5 };
  const searchArgs = { path: directory, searchPattern: 'marker', maxResults: 5 };
  const firstFind = metadata<Found>(await call(client, 'find_files', findArgs));
  const firstSearch = metadata<Searched>(await call(client, 'search_text', searchArgs));
  assert.ok(firstFind.nextCursor);
  assert.ok(firstSearch.nextCursor);
  assert.equal(firstFind.results.length, 5);
  assert.equal(firstSearch.matches.length, 5);
  assert.equal(firstFind.totalMatches, count);
  assert.equal(firstSearch.totalMatches, count);

  // Mutate after both snapshots exist: continuation must not re-scan the live directory.
  const late = join(directory, 'late.txt');
  await call(client, 'create', { files: [{ path: late, content: 'marker late\n' }] });
  await call(client, 'delete', { paths: [join(directory, 'item-23.txt')] });
  await assertBytes(late, 'marker late\n');
  await assert.rejects(stat(join(directory, 'item-23.txt')), { code: 'ENOENT' });

  const paths = firstFind.results.map((item) => item.path);
  const matches = [...firstSearch.matches];
  let findCursor: string | undefined = firstFind.nextCursor;
  let searchCursor: string | undefined = firstSearch.nextCursor;
  for (let page = 1; page < 5; page++) {
    assert.ok(findCursor, `find page ${page}`);
    assert.ok(searchCursor, `search page ${page}`);
    const findRequest: Record<string, unknown> = { ...findArgs, cursor: findCursor };
    const searchRequest: Record<string, unknown> = { ...searchArgs, cursor: searchCursor };
    const found: Found = metadata<Found>(await call(client, 'find_files', findRequest));
    const searched: Searched = metadata<Searched>(await call(client, 'search_text', searchRequest));
    if (page === 1) {
      assert.deepEqual(metadata(await call(client, 'find_files', findRequest)), found);
      assert.deepEqual(metadata(await call(client, 'search_text', searchRequest)), searched);
    }
    assert.equal(found.totalMatches, count);
    assert.equal(searched.totalMatches, count);
    assert.equal(found.results.length, Math.min(5, count - page * 5));
    assert.equal(searched.matches.length, Math.min(5, count - page * 5));
    paths.push(...found.results.map((item) => item.path));
    matches.push(...searched.matches);
    findCursor = found.nextCursor;
    searchCursor = searched.nextCursor;
  }
  assert.equal(findCursor, undefined);
  assert.equal(searchCursor, undefined);
  // Result paths are relative to the root, so a scoped search names its folder.
  const underRoot = (name: string): string => `many/${name}`;
  assert.deepEqual(paths, names.map(underRoot));
  assert.deepEqual(
    matches.map(({ file, line, content }) => ({ file, line, content })),
    names.map((name) => ({ file: underRoot(name), line: 1, content: `marker ${name}` })),
  );
  const currentNames = [...names.slice(0, -1), 'late.txt'];
  const fresh = metadata<Found>(await call(client, 'find_files', { ...findArgs, maxResults: 100 }));
  assert.deepEqual(
    fresh.results.map((item) => item.path),
    currentNames.map(underRoot),
  );
  assert.deepEqual((await readdir(directory)).sort(), currentNames);
  for (const name of currentNames) {
    await assertBytes(
      join(directory, name),
      name === 'late.txt' ? 'marker late\n' : `marker ${name}\n`,
    );
  }
}

describe('isolated sandbox integration', { concurrency: false }, () => {
  it('waits for sibling operations before propagating a concurrent failure', async () => {
    const failure = new Error('synthetic assertion failure');
    const sibling = Promise.withResolvers<undefined>();
    let finished = false;
    const completion = finishConcurrent([Promise.reject(failure), sibling.promise]).finally(() => {
      finished = true;
    });
    const rejected = assert.rejects(completion, (error) => error === failure);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(finished, false, 'cleanup must wait for the pending sibling');
    sibling.resolve(undefined);
    await rejected;
    assert.equal(finished, true);
  });

  for (const transport of ['stdio', 'http'] as const) {
    it(`${transport}: all tools cooperate in a guarded lifecycle`, async () => {
      await isolated(transport, lifecycle);
    });
    it(`${transport}: bounded concurrent writes and stable search snapshots`, async () => {
      await isolated(transport, stress);
    });
  }

  it('stdio: read-only mode advertises only observers and refuses a write without changing bytes', async () => {
    await isolated(
      'stdio',
      async (client, root) => {
        const path = join(root, 'readonly.txt');
        await writeFile(path, 'unchanged\n');
        assert.deepEqual(
          (await client.listTools()).tools.map((tool) => tool.name).sort(),
          READ_ONLY_NAMES,
        );
        assert.equal(firstTextBlock(await call(client, 'read', { path })).text, 'unchanged\n');
        await assert.rejects(
          client.callTool({
            name: 'create',
            arguments: { files: [{ path, content: 'changed', overwrite: true }] },
          }),
          /not found|unknown tool/i,
        );
        await assertBytes(path, 'unchanged\n');
        assert.deepEqual(await readdir(root), ['readonly.txt']);
      },
      true,
    );
  });
});
