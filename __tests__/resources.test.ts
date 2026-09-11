import { McpServer, ProtocolErrorCode, ResourceNotFoundError } from '@modelcontextprotocol/server';
import type { ReadResourceResult, ServerContext } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { NO_POSITIONAL_ROOTS_GUIDANCE } from '../src/core/config.js';
import { ErrorCode, isFsError } from '../src/core/errors.js';
import { buildFileResourceUri, encodeFileUriPath, extractPath } from '../src/core/file-uri.js';
import { isSamePath } from '../src/core/path-utils.js';
import { PathGuard } from '../src/core/path.js';
import { ResourceStore } from '../src/core/store.js';
import { createWatcherRegistry } from '../src/core/watcher-registry.js';
import { buildSectionsRecord, INSTRUCTIONS_URI, renderSections } from '../src/instructions.js';
import { getResourceContracts, registerResources } from '../src/resources.js';
import { createServer } from '../src/server.js';
import { MUTATING_TOOL_NAMES } from '../src/tools/index.js';
import {
  cleanupTestRoot,
  createTestClientPair,
  createTestRoot,
  makeGuard,
  waitFor,
  writeTestFile,
} from './helpers.js';

const dummyContext = { sessionId: 'test-session' } as unknown as ServerContext;

function requiredSection(sections: Record<string, string>, key: string): string {
  const value = sections[key];
  assert.ok(value, `expected instruction section ${key}`);
  return value;
}

function firstResourceContent(result: ReadResourceResult): ReadResourceResult['contents'][number] {
  const content = result.contents[0];
  assert.ok(content, 'expected one resource content item');
  return content;
}

describe('MCP Resources', () => {
  describe('internal://instructions (TC-FUNC-055–057)', () => {
    it('TC-FUNC-055: buildSectionsRecord produces guidelines, tools_overview, constraints, error_recovery', () => {
      const sections = buildSectionsRecord(false);

      assert.ok('guidelines' in sections, 'guidelines should be present');
      assert.ok('tools_overview' in sections, 'tools_overview should be present');
      assert.ok('constraints' in sections, 'constraints should be present');
      assert.ok('error_recovery' in sections, 'error_recovery should be present');

      // Verify guidelines content
      const guidelines = requiredSection(sections, 'guidelines');
      assert.match(guidelines, /root_access:/);
      assert.match(guidelines, /path_resolution:/);

      // Verify constraints content
      const constraints = requiredSection(sections, 'constraints');
      assert.match(constraints, /allowed_roots:/);
      assert.match(constraints, /sensitive_paths:/);
      assert.match(constraints, /enforced_limits:/);
      assert.match(constraints, /ephemeral_results:/);
      assert.match(constraints, /pagination: nextCursor appears in the result text and in _meta,/);

      // Verify error recovery content
      const errorRecovery = requiredSection(sections, 'error_recovery');
      assert.match(errorRecovery, /ACCESS_DENIED:/);
      assert.match(errorRecovery, /NOT_FOUND:/);
      assert.match(errorRecovery, /TOO_LARGE:/);
      assert.match(errorRecovery, /TIMEOUT:/);
      assert.match(errorRecovery, /INVALID_INPUT:/);
    });

    it('TC-FUNC-055a: modern root guidance lists known roots and explicit bootstrap paths', () => {
      const sections = buildSectionsRecord(false);
      const guidelines = requiredSection(sections, 'guidelines');
      const constraints = requiredSection(sections, 'constraints');

      assert.match(guidelines, /configured or accepted roots/i);
      assert.match(guidelines, /modern.*concrete path.*grant/i);
      assert.match(constraints, /legacy.*roots\/list/i);
      assert.doesNotMatch(guidelines, /discover.*unknown workspace/i);

      assert.match(NO_POSITIONAL_ROOTS_GUIDANCE, /FS_ALLOWED_DIRS/);
      assert.match(NO_POSITIONAL_ROOTS_GUIDANCE, /--allow-cwd/);
      assert.match(NO_POSITIONAL_ROOTS_GUIDANCE, /concrete path/);
    });

    it('TC-FUNC-056: tools_overview behavior under readOnly true vs false', () => {
      // When readOnly = false, mutating tools are listed under Write
      const sectionsWritable = buildSectionsRecord(false);
      const writableTools = requiredSection(sectionsWritable, 'tools_overview');
      assert.match(writableTools, /Navigate:/);
      assert.match(writableTools, /Inspect:/);
      assert.match(writableTools, /Read:/);
      assert.match(writableTools, /Write:/);

      for (const toolName of MUTATING_TOOL_NAMES) {
        assert.ok(
          writableTools.includes(toolName),
          `Mutating tool ${toolName} should be in tools_overview when readOnly=false`,
        );
      }

      // When readOnly = true, "Write" section is omitted from tools_overview
      const sectionsReadOnly = buildSectionsRecord(true);
      const readOnlyTools = requiredSection(sectionsReadOnly, 'tools_overview');
      assert.match(readOnlyTools, /Navigate:/);
      assert.match(readOnlyTools, /Inspect:/);
      assert.match(readOnlyTools, /Read:/);
      assert.doesNotMatch(readOnlyTools, /Write:/);

      for (const toolName of MUTATING_TOOL_NAMES) {
        assert.ok(
          !readOnlyTools.includes(toolName),
          `Mutating tool ${toolName} should not be in tools_overview when readOnly=true`,
        );
      }
    });

    it('TC-FUNC-057: renderSections formats markdown and instructions contract reads correctly', async () => {
      const sections = buildSectionsRecord(false);
      const rendered = renderSections(sections);

      assert.strictEqual(typeof rendered, 'string');
      assert.ok(rendered.startsWith('\nGuidelines:'));
      assert.ok(rendered.includes('\n\nTools Overview:'));
      assert.ok(rendered.includes('\n\nConstraints:'));
      assert.ok(rendered.includes('\n\nError Recovery:'));
      assert.ok(rendered.endsWith('\n'));

      // Test reading via resource contract
      const store = new ResourceStore();
      const contracts = getResourceContracts({
        resourceStore: store,
        pathGuard: await makeGuard([tmpdir()]),
        readOnly: false,
      });
      const instructionsContract = contracts.find((c) => c.name === 'filesystem-mcp-instructions');

      assert.ok(instructionsContract, 'filesystem-mcp-instructions contract should be present');
      assert.strictEqual(instructionsContract.uri, INSTRUCTIONS_URI);
      assert.strictEqual(instructionsContract.mimeType, 'text/markdown');

      const readResult = await instructionsContract.read(
        new URL(INSTRUCTIONS_URI),
        {},
        dummyContext,
      );

      assert.strictEqual(readResult.contents.length, 1);
      const instructionsContent = firstResourceContent(readResult);
      assert.strictEqual(instructionsContent.uri, INSTRUCTIONS_URI);
      assert.strictEqual(instructionsContent.mimeType, 'text/markdown');
      assert.ok('text' in instructionsContent);
      assert.strictEqual(instructionsContent.text, rendered);
    });
  });

  describe('filesystem-mcp://result/{id} (TC-FUNC-058–060)', () => {
    it('TC-FUNC-058: Store a text entry in ResourceStore and verify text, mimeType', () => {
      const store = new ResourceStore();
      const content = 'Sample calculation result content\nLine 2';

      const entry = store.putText({
        name: 'test_calc',
        mimeType: 'text/plain',
        text: content,
      });

      assert.ok(entry.uri.startsWith('filesystem-mcp://result/'));
      assert.strictEqual(entry.name, 'test_calc');
      assert.strictEqual(entry.mimeType, 'text/plain');
      assert.strictEqual(entry.text, content);

      // Retrieve via getEntry
      const retrievedEntry = store.getEntry(entry.uri);
      assert.strictEqual(retrievedEntry.uri, entry.uri);
      assert.strictEqual(retrievedEntry.text, content);
    });

    it('TC-FUNC-059: Read cached result via resource contract', async () => {
      const store = new ResourceStore();
      const contracts = getResourceContracts({
        resourceStore: store,
        pathGuard: await makeGuard([tmpdir()]),
        readOnly: false,
      });
      const resultContract = contracts.find((c) => c.name === 'filesystem-mcp-result');

      assert.ok(resultContract, 'filesystem-mcp-result contract should be present');
      assert.strictEqual(resultContract.uriTemplate, 'filesystem-mcp://result/{id}');

      // Test text cached result
      const textEntry = store.putText({
        name: 'summary_result',
        mimeType: 'text/markdown',
        text: '# Test Summary',
      });
      const textUrl = new URL(textEntry.uri);
      const textId = textUrl.pathname.replace(/^\//, '');

      const textRead = await resultContract.read(textUrl, { id: textId }, dummyContext);
      assert.strictEqual(textRead.contents.length, 1);
      const cachedContent = firstResourceContent(textRead);
      assert.strictEqual(cachedContent.uri, textEntry.uri);
      assert.strictEqual(cachedContent.mimeType, 'text/markdown');
      assert.ok('text' in cachedContent);
      assert.strictEqual(cachedContent.text, '# Test Summary');
    });

    it('TC-FUNC-060: Missing entry throws NOT_FOUND / ResourceNotFoundError', async () => {
      const store = new ResourceStore();
      const nonExistentUri = 'filesystem-mcp://result/00000000-0000-0000-0000-000000000000';

      // Direct store access throws FsError with NOT_FOUND
      assert.throws(
        () => store.getEntry(nonExistentUri),
        (err: unknown) => {
          assert(isFsError(err));
          assert.strictEqual(err.code, ErrorCode.NOT_FOUND);
          return true;
        },
      );

      // Contract read on missing result throws ResourceNotFoundError
      const contracts = getResourceContracts({
        resourceStore: store,
        pathGuard: await makeGuard([tmpdir()]),
        readOnly: false,
      });
      const resultContract = contracts.find((c) => c.name === 'filesystem-mcp-result');
      assert.ok(resultContract, 'filesystem-mcp-result contract should exist');

      await assert.rejects(
        async () => {
          await resultContract.read(
            new URL(nonExistentUri),
            { id: '00000000-0000-0000-0000-000000000000' },
            dummyContext,
          );
        },
        { code: ProtocolErrorCode.InvalidParams },
      );

      // Contract read with empty or missing id throws ProtocolError
      await assert.rejects(
        async () => {
          await resultContract.read(new URL('filesystem-mcp://result/'), { id: '' }, dummyContext);
        },
        { code: ProtocolErrorCode.InvalidParams },
      );
    });

    it('TC-FUNC-060A: resourcesListChanged emits once per ResourceStore mutation', () => {
      let notifications = 0;
      const store = new ResourceStore(() => {
        notifications += 1;
      });

      store.putText({ name: 'first', text: 'first' });
      assert.strictEqual(notifications, 1, 'insertion must emit one list change');

      for (let i = 1; i < 64; i += 1) {
        store.putText({ name: `entry-${String(i)}`, text: String(i) });
      }
      notifications = 0;
      store.putText({ name: 'evicting-entry', text: 'last' });

      assert.strictEqual(notifications, 1, 'insert plus eviction must be coalesced');
      assert.strictEqual(store.keys().length, 64, 'entry limit must still be enforced');
    });
  });

  describe('filesystem-mcp://file/{+path} (TC-FUNC-061–066)', () => {
    let tmpDir: string;
    let pathGuard: PathGuard;
    let store: ResourceStore;

    before(async () => {
      tmpDir = await createTestRoot();
      pathGuard = await makeGuard([tmpDir]);
      store = new ResourceStore();
    });

    after(async () => {
      if (tmpDir) {
        await cleanupTestRoot(tmpDir);
      }
    });

    it('TC-FUNC-061: Read workspace text file via resource contract', async () => {
      const textContent = 'Hello from workspace file!\nLine 2 content.';
      const filePath = await writeTestFile(tmpDir, 'document.txt', textContent);
      const uriString = buildFileResourceUri(filePath);
      const uri = new URL(uriString);

      const contracts = getResourceContracts({
        resourceStore: store,
        pathGuard,
        readOnly: false,
      });
      const fileContract = contracts.find((c) => c.name === 'filesystem-mcp-file');
      assert.ok(fileContract, 'filesystem-mcp-file contract should be present');

      const result = await fileContract.read(uri, { path: filePath }, dummyContext);

      assert.strictEqual(result.contents.length, 1);
      const textResource = firstResourceContent(result);
      assert.strictEqual(textResource.uri, uri.href);
      assert.strictEqual(textResource.mimeType, 'text/plain');
      assert.ok('text' in textResource);
      assert.strictEqual(textResource.text, textContent);
    });

    it('TC-FUNC-062: Read workspace binary file via resource contract', async () => {
      // PNG header magic bytes
      const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const binPath = join(tmpDir, 'image.png');
      await writeFile(binPath, pngBytes);

      const uriString = buildFileResourceUri(binPath);
      const uri = new URL(uriString);

      const contracts = getResourceContracts({
        resourceStore: store,
        pathGuard,
        readOnly: false,
      });
      const fileContract = contracts.find((c) => c.name === 'filesystem-mcp-file');
      assert.ok(fileContract, 'filesystem-mcp-file contract should exist');

      const result = await fileContract.read(uri, { path: binPath }, dummyContext);

      assert.strictEqual(result.contents.length, 1);
      const binaryResource = firstResourceContent(result);
      assert.strictEqual(binaryResource.uri, uri.href);
      assert.strictEqual(binaryResource.mimeType, 'image/png');
      assert.ok('blob' in binaryResource);
      assert.strictEqual(binaryResource.blob, pngBytes.toString('base64'));
      assert.ok(!('text' in binaryResource));
    });

    it('TC-FUNC-063: WatcherRegistry - acquire attaches a watcher and debounces notifications', async () => {
      const registry = createWatcherRegistry();
      const testFile = await writeTestFile(tmpDir, 'watch_test.txt', 'initial');
      const testUri = buildFileResourceUri(testFile);

      const notifications: string[] = [];
      const result = await registry.acquire(pathGuard, testUri, (uri) => {
        notifications.push(uri);
      });
      assert.strictEqual(result.ok, true);
      assert.strictEqual(registry.hasWatcher(testUri), true);

      // Trigger file modification
      await writeFile(testFile, 'updated content');

      // Poll for the debounced notification (50ms debounce) — fixed waits flake on loaded CI.
      await waitFor(() => notifications.length > 0, 1000);

      assert.ok(notifications.length >= 1, 'Watcher callback should have received notification');
      assert.strictEqual(notifications[0], testUri);

      registry.destroy();
    });

    it('TC-FUNC-064: WatcherRegistry - release tears down the watcher and leaves no stale state', async () => {
      const registry = createWatcherRegistry();
      const testFile = await writeTestFile(tmpDir, 'remove_test.txt', 'content');
      const testUri = buildFileResourceUri(testFile);

      const result = await registry.acquire(pathGuard, testUri, () => {});
      assert.strictEqual(result.ok, true);
      assert.strictEqual(registry.hasWatcher(testUri), true);

      registry.release(testUri);
      assert.strictEqual(registry.hasWatcher(testUri), false);
      // No stale state: a fresh acquire for the same uri succeeds.
      const reacquired = await registry.acquire(pathGuard, testUri, () => {});
      assert.strictEqual(reacquired.ok, true);

      registry.destroy();
    });

    it('TC-FUNC-064A: WatcherRegistry - callback identity is independent from leases', async () => {
      const registry = createWatcherRegistry();
      const testFile = await writeTestFile(tmpDir, 'lease_test.txt', 'content');
      const testUri = buildFileResourceUri(testFile);
      let notifications = 0;
      const callback = () => {
        notifications += 1;
      };

      // Two leases on one callback identity: the registry de-duplicates the
      // sink, so one filesystem event still fires it once.
      const first = await registry.acquire(pathGuard, testUri, callback);
      const second = await registry.acquire(pathGuard, testUri, callback);
      assert.strictEqual(first.ok, true);
      assert.strictEqual(second.ok, true);
      assert.strictEqual(registry.size(), 1);

      await writeFile(testFile, 'changed');
      await waitFor(() => notifications > 0, 1000);

      assert.strictEqual(notifications, 1, 'one filesystem event must invoke one callback');

      registry.release(testUri);
      assert.strictEqual(registry.hasWatcher(testUri), true, 'one retained lease must remain');
      registry.release(testUri);
      assert.strictEqual(registry.hasWatcher(testUri), false, 'last release must drop the watcher');

      registry.destroy();
    });

    it('TC-FUNC-065: WatcherRegistry - size reports the live watcher count', () => {
      const registry = createWatcherRegistry();
      assert.strictEqual(registry.size(), 0);
      registry.destroy();
    });

    it('TC-FUNC-066: WatcherRegistry - destroy closes all watchers and makes every uri stale', async () => {
      const registry = createWatcherRegistry();
      const fileA = await writeTestFile(tmpDir, 'destroy_a.txt', 'A');
      const fileB = await writeTestFile(tmpDir, 'destroy_b.txt', 'B');
      const freshFile = await writeTestFile(tmpDir, 'never_watched.txt', 'C');
      const uriA = buildFileResourceUri(fileA);
      const uriB = buildFileResourceUri(fileB);
      const freshUri = buildFileResourceUri(freshFile);

      assert.strictEqual((await registry.acquire(pathGuard, uriA, () => {})).ok, true);
      assert.strictEqual((await registry.acquire(pathGuard, uriB, () => {})).ok, true);

      assert.strictEqual(registry.hasWatcher(uriA), true);
      assert.strictEqual(registry.hasWatcher(uriB), true);
      assert.strictEqual(registry.size(), 2);

      registry.destroy();

      assert.strictEqual(registry.hasWatcher(uriA), false);
      assert.strictEqual(registry.hasWatcher(uriB), false);
      assert.strictEqual(registry.size(), 0);
      // Destroyed registry: even a uri never watched aborts as stale.
      assert.deepStrictEqual(await registry.acquire(pathGuard, freshUri, () => {}), {
        ok: false,
        reason: 'stale',
      });
    });

    it('TC-FUNC-067: WatcherRegistry - release during in-flight subscribe marks stale; settled release does not', async () => {
      const registry = createWatcherRegistry();
      const file = await writeTestFile(tmpDir, 'resub.txt', 'content');
      const uri = buildFileResourceUri(file);

      // Settled subscribe then release: no stale marker, a fresh acquire works.
      assert.strictEqual(
        (await registry.acquire(pathGuard, uri, () => {}, { markSubscribe: true })).ok,
        true,
      );
      registry.release(uri);
      assert.strictEqual(registry.hasWatcher(uri), false);
      const reacquired = await registry.acquire(pathGuard, uri, () => {}, { markSubscribe: true });
      assert.strictEqual(reacquired.ok, true);
      registry.release(uri);

      // In-flight abort: a release landing while path validation is still
      // awaited must abort the acquire as stale.
      let openGate: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        openGate = resolve;
      });
      const gatedGuard = {
        validateExistingPath: async (filePath: string) => {
          await gate;
          return pathGuard.validateExistingPath(filePath);
        },
      } as unknown as PathGuard;
      const inFlight = registry.acquire(gatedGuard, uri, () => {}, { markSubscribe: true });
      registry.release(uri);
      openGate();
      assert.deepStrictEqual(await inFlight, { ok: false, reason: 'stale' });

      // And a fresh acquire clears the marker and succeeds again.
      const resumed = await registry.acquire(pathGuard, uri, () => {}, { markSubscribe: true });
      assert.strictEqual(resumed.ok, true);
      registry.release(uri);

      registry.destroy();
    });
  });

  describe('MCP Client Resource Operations', () => {
    let clientTmpDir: string;
    let harness: Awaited<ReturnType<typeof createTestClientPair>>;

    before(async () => {
      clientTmpDir = await createTestRoot();
      harness = await createTestClientPair([clientTmpDir]);
    });

    after(async () => {
      if (harness) {
        await harness.close();
      }
      if (clientTmpDir) {
        await cleanupTestRoot(clientTmpDir);
      }
    });

    it('client.listResources() returns the static instructions resource and no per-root entries', async () => {
      const result = await harness.client.listResources();
      const instructions = result.resources.find((r) => r.uri === INSTRUCTIONS_URI);
      assert.ok(instructions, 'instructions resource should be present');
      assert.strictEqual(instructions.mimeType, 'text/markdown');

      // Allowed roots are not listed as concrete resources; the
      // filesystem-mcp://file/{+path} template and list_roots cover them.
      const allowedRoots = harness.serverCtx.pathGuard.getAllowedDirectories();
      const rootUri = buildFileResourceUri(allowedRoots[0] ?? clientTmpDir);
      assert.strictEqual(
        result.resources.some((r) => r.uri === rootUri),
        false,
        'workspace roots must not be duplicated into resources/list',
      );
    });

    it('resource contracts specify cacheHint for client caching optimization', async () => {
      const store = new ResourceStore();
      const contracts = getResourceContracts({
        resourceStore: store,
        pathGuard: await makeGuard([tmpdir()]),
        readOnly: false,
      });
      const instructions = contracts.find((c) => c.name === 'filesystem-mcp-instructions');
      assert.deepStrictEqual(instructions?.cacheHint, { cacheScope: 'public', ttlMs: 300_000 });

      const resultContract = contracts.find((c) => c.name === 'filesystem-mcp-result');
      assert.deepStrictEqual(resultContract?.cacheHint, { cacheScope: 'private', ttlMs: 60_000 });
    });

    it('client.listResourceTemplates() returns result and file templates', async () => {
      const result = await harness.client.listResourceTemplates();
      assert.ok(result.resourceTemplates.length >= 2);
      assert.ok(
        result.resourceTemplates.some((t) => t.uriTemplate === 'filesystem-mcp://result/{id}'),
      );
      assert.ok(
        result.resourceTemplates.some((t) => t.uriTemplate === 'filesystem-mcp://file/{+path}'),
      );

      // Every entry the result store writes is JSON (putJsonResource), so the
      // template must not advertise a type none of its resources have.
      const resultTemplate = result.resourceTemplates.find(
        (t) => t.uriTemplate === 'filesystem-mcp://result/{id}',
      );
      assert.strictEqual(resultTemplate?.mimeType, 'application/json');
    });

    it('client.readResource() reads internal instructions', async () => {
      const result = await harness.client.readResource({ uri: INSTRUCTIONS_URI });
      assert.strictEqual(result.contents.length, 1);
      const instructionsContent = firstResourceContent(result);
      assert.strictEqual(instructionsContent.uri, INSTRUCTIONS_URI);
      assert.strictEqual(instructionsContent.mimeType, 'text/markdown');
      assert.ok('text' in instructionsContent);
      assert.ok(instructionsContent.text.includes('Guidelines:'));
    });

    it('client.readResource() reads workspace file via uri', async () => {
      const filePath = await writeTestFile(clientTmpDir, 'client_read.txt', 'client resource read');
      const uri = buildFileResourceUri(filePath);
      const result = await harness.client.readResource({ uri });
      assert.strictEqual(result.contents.length, 1);
      const fileContent = firstResourceContent(result);
      assert.strictEqual(fileContent.uri, uri);
      assert.ok('text' in fileContent);
      assert.strictEqual(fileContent.text, 'client resource read');
    });

    it('client.readResource() on a missing workspace file rejects as resource-not-found', async () => {
      const uri = buildFileResourceUri(join(clientTmpDir, 'does-not-exist.txt'));
      await assert.rejects(harness.client.readResource({ uri }), (err: unknown) => {
        // The SDK reconstructs ResourceNotFoundError client-side from the wire
        // code plus `data.uri`; its wire code is -32602 (spec MUST for
        // 2026-07-28), with -32002 accepted only for backwards compatibility.
        assert.ok(ResourceNotFoundError.isInstance(err), 'expected ResourceNotFoundError');
        assert.strictEqual(err.code, ProtocolErrorCode.InvalidParams);
        assert.strictEqual(err.uri, uri);
        return true;
      });
    });

    it('advertises resources.subscribe and resources.listChanged capabilities', async () => {
      const serverContext = await createServer({ cliAllowedDirs: [clientTmpDir] });
      const capabilities = serverContext.mcp.server.getCapabilities();
      assert.strictEqual(capabilities.resources?.subscribe, true);
      assert.strictEqual(capabilities.resources?.listChanged, true);
      serverContext.disposeRuntimeState();
      await serverContext.mcp.close();
    });
  });

  it('legacy resource registration refuses to replace an existing request handler', async () => {
    const root = await createTestRoot();
    const pathGuard = await makeGuard([root]);
    const server = new McpServer({ name: 'resource-collision-test', version: '1.0.0' });
    server.server.setRequestHandler('resources/subscribe', async () => ({}));

    try {
      assert.throws(
        () =>
          registerResources({
            server,
            pathGuard,
            resourceStore: new ResourceStore(),
            readOnly: false,
            era: 'legacy',
          }),
        /handler|registered|resources\/subscribe/iu,
      );
    } finally {
      await server.close();
      await cleanupTestRoot(root);
    }
  });
});

describe('filesystem resource path completion', () => {
  let root: string;

  before(async () => {
    root = await createTestRoot();
  });

  after(async () => {
    await cleanupTestRoot(root);
  });

  // Completion values are expanded into `filesystem-mcp://file/{+path}` verbatim
  // by the client, so they must be in the same encoded form the server's own
  // encoder emits. A raw OS path with a '#' in it builds a URI whose fragment
  // starts mid-filename, and extractPath then names a different file.
  it('returns {+path} values that round-trip back to the file they named', async () => {
    const hashFile = await writeTestFile(root, 'has#hash.txt', 'x');
    const pathGuard = await makeGuard([root]);
    const contracts = getResourceContracts({
      resourceStore: new ResourceStore(),
      pathGuard,
      readOnly: false,
    });
    const fileContract = contracts.find((c) => c.name === 'filesystem-mcp-file');
    assert.ok(fileContract?.complete, 'file contract should expose a path completer');

    // The partial is in the encoded form a prior suggestion would have had, so
    // this exercises the decode side too.
    const suggestions = await fileContract.complete.path(encodeFileUriPath(join(root, 'has#')));

    // isSamePath, not ===: extractPath yields POSIX separators on every
    // platform and normalizePath lower-cases the Windows drive letter, so the
    // round-trip is path-equal rather than string-equal.
    const match = suggestions.find((s) =>
      isSamePath(extractPath(`filesystem-mcp://file/${s}`) ?? '', hashFile),
    );
    assert.ok(match, `no suggestion round-tripped to ${hashFile}: ${JSON.stringify(suggestions)}`);
    assert.ok(!match.includes('#'), `'#' must be percent-encoded in the template value: ${match}`);
  });
});
